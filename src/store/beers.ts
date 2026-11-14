// Beers in the single table:
//   beer       pk = BEER       sk = BEER#<id>
//   name lock  pk = BEERNAME   sk = <nameKey>   - makes names unique
// Beers share a partition so the catalogue is one Query that never reads a
// lock. A beer and its name lock always change in one transaction, and every
// write that depends on a beer's name is conditioned on that name still being
// current, so a concurrent rename or retire can never strand a lock.
import { ConditionalCheckFailedException, TransactionCanceledException, TransactionConflictException } from "@aws-sdk/client-dynamodb";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { nameKey, type BeerChanges, type StoredBeer } from "../domain/beer.ts";
import { dynamo, tableName } from "../lib/dynamo.ts";

export class NameTaken extends Error {}
export class BeerNotFound extends Error {}

/** What was read has changed, or another write is in flight: read again and retry. */
class Stale extends Error {}

const beerKey = (id: string) => ({ pk: "BEER", sk: `BEER#${id}` });
const lockKey = (name: string) => ({ pk: "BEERNAME", sk: nameKey(name) });

/** The beer exists and still has the name this write was planned against. */
const STILL_NAMED = "attribute_exists(pk) AND #name = :expected_name";

function fromItem(item: Record<string, any>): StoredBeer {
  const { pk, sk, ...beer } = item;
  return beer as StoredBeer;
}

/** Re-run `work` when it finds the data changed underneath it. */
async function retrying<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof Stale) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt * (0.5 + Math.random())));
    }
  }
}

/** For single-item writes: a failed condition or a clash with a transaction means the read was stale. */
function staleIfConcurrent(error: unknown): never {
  if (error instanceof ConditionalCheckFailedException || error instanceof TransactionConflictException) throw new Stale();
  throw error;
}

type Step = {
  item: NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
  /** What a failed condition on this item means: an error to report, or STALE to read again. */
  onConditionFailed?: Error | typeof STALE;
};
const STALE = Symbol("stale");

async function transact(steps: Step[]): Promise<void> {
  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: steps.map((step) => step.item) }));
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) throw error;
    const reasons = error.CancellationReasons ?? [];
    if (reasons.some((reason) => reason.Code === "TransactionConflict")) throw new Stale();
    const failed = steps.filter((_, i) => reasons[i]?.Code === "ConditionalCheckFailed").map((step) => step.onConditionFailed);
    // A stale read outranks everything else: the retry re-reads and reports what is true now.
    if (failed.includes(STALE)) throw new Stale();
    const reported = failed.find((outcome): outcome is Error => outcome instanceof Error);
    throw reported ?? error;
  }
}

export function putNewBeer(beer: StoredBeer): Promise<void> {
  return retrying(() =>
    transact([
      {
        item: { Put: { TableName: tableName, Item: { ...lockKey(beer.name), beer_id: beer.id }, ConditionExpression: "attribute_not_exists(pk)" } },
        onConditionFailed: new NameTaken(),
      },
      { item: { Put: { TableName: tableName, Item: { ...beerKey(beer.id), ...beer }, ConditionExpression: "attribute_not_exists(pk)" } } },
    ]),
  );
}

export async function readBeer(id: string): Promise<StoredBeer | undefined> {
  const { Item } = await dynamo.send(new GetCommand({ TableName: tableName, Key: beerKey(id), ConsistentRead: true }));
  return Item && fromItem(Item);
}

export async function readBeers(style?: string): Promise<StoredBeer[]> {
  // One partition holds only beers, so this reads no locks. The style filter
  // still reads every beer; give styles an index before the catalogue is large.
  const beers: StoredBeer[] = [];
  let start: Record<string, any> | undefined;
  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        ConsistentRead: true,
        ExclusiveStartKey: start,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": beerKey("").pk, ...(style ? { ":style": style } : {}) },
        ...(style ? { FilterExpression: "#style = :style", ExpressionAttributeNames: { "#style": "style" } } : {}),
      }),
    );
    beers.push(...(page.Items ?? []).map(fromItem));
    start = page.LastEvaluatedKey;
  } while (start);
  return beers;
}

export function applyChanges(id: string, changes: BeerChanges, updated_at: string): Promise<StoredBeer> {
  return retrying(async () => {
    const current = await readBeer(id);
    if (!current) throw new BeerNotFound();

    const next = { ...changes, updated_at };
    const fields = Object.keys(next);
    const update = {
      TableName: tableName,
      Key: beerKey(id),
      ConditionExpression: STILL_NAMED,
      UpdateExpression: "SET " + fields.map((f) => `#${f} = :${f}`).join(", "),
      ExpressionAttributeNames: { ...Object.fromEntries(fields.map((f) => [`#${f}`, f])), "#name": "name" },
      ExpressionAttributeValues: { ...Object.fromEntries(Object.entries(next).map(([f, v]) => [`:${f}`, v])), ":expected_name": current.name },
    };

    const takesNewLock = changes.name !== undefined && nameKey(changes.name) !== nameKey(current.name);
    if (!takesNewLock) {
      // Same lock (or no rename): one write, and it returns the beer as stored.
      const { Attributes } = await dynamo.send(new UpdateCommand({ ...update, ReturnValues: "ALL_NEW" })).catch(staleIfConcurrent);
      return fromItem(Attributes!);
    }

    await transact([
      {
        item: { Put: { TableName: tableName, Item: { ...lockKey(changes.name!), beer_id: id }, ConditionExpression: "attribute_not_exists(pk)" } },
        onConditionFailed: new NameTaken(),
      },
      { item: { Update: update }, onConditionFailed: STALE },
      { item: { Delete: { TableName: tableName, Key: lockKey(current.name) } } },
    ]);
    // A transaction cannot return the item. Read it for its current ratings;
    // if it has been retired since, the update still happened, so answer with it.
    return (await readBeer(id)) ?? { ...current, ...next };
  });
}

export function deleteBeer(id: string): Promise<void> {
  return retrying(async () => {
    const current = await readBeer(id);
    if (!current) throw new BeerNotFound();
    await transact([
      {
        item: {
          Delete: {
            TableName: tableName,
            Key: beerKey(id),
            ConditionExpression: STILL_NAMED,
            ExpressionAttributeNames: { "#name": "name" },
            ExpressionAttributeValues: { ":expected_name": current.name },
          },
        },
        onConditionFailed: STALE,
      },
      { item: { Delete: { TableName: tableName, Key: lockKey(current.name) } } },
    ]);
  });
}

export function addRating(id: string, score: number, updated_at: string): Promise<StoredBeer> {
  return retrying(async () => {
    try {
      const { Attributes } = await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: beerKey(id),
          ConditionExpression: "attribute_exists(pk)",
          UpdateExpression: "ADD rating_count :one, rating_total :score SET updated_at = :updated_at",
          ExpressionAttributeValues: { ":one": 1, ":score": score, ":updated_at": updated_at },
          ReturnValues: "ALL_NEW",
        }),
      );
      return fromItem(Attributes!);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) throw new BeerNotFound();
      if (error instanceof TransactionConflictException) throw new Stale();
      throw error;
    }
  });
}

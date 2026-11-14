// Beers in the single table:
//   beer       pk = BEER#<id>            sk = BEER
//   name lock  pk = BEERNAME#<nameKey>   sk = LOCK   - makes names unique
// A beer and its name lock are always written in one transaction.
import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { nameKey, type BeerChanges, type StoredBeer } from "../domain/beer.ts";
import { dynamo, tableName } from "../lib/dynamo.ts";

export class NameTaken extends Error {}
export class BeerNotFound extends Error {}

const beerKey = (id: string) => ({ pk: `BEER#${id}`, sk: "BEER" });
const lockKey = (name: string) => ({ pk: `BEERNAME#${nameKey(name)}`, sk: "LOCK" });

function fromItem(item: Record<string, any>): StoredBeer {
  const { pk, sk, entity, ...beer } = item;
  return beer as StoredBeer;
}

/** Run a transaction whose items carry conditions; `onFailure[i]` is thrown when item i's condition fails. */
async function transact(items: NonNullable<TransactWriteCommand["input"]["TransactItems"]>, onFailure: (Error | undefined)[]): Promise<void> {
  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      const failed = (error.CancellationReasons ?? []).findIndex((reason) => reason.Code === "ConditionalCheckFailed");
      const mapped = onFailure[failed];
      if (mapped) throw mapped;
    }
    throw error;
  }
}

export async function putNewBeer(beer: StoredBeer): Promise<void> {
  await transact(
    [
      { Put: { TableName: tableName, Item: { ...lockKey(beer.name), beer_id: beer.id }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: tableName, Item: { ...beerKey(beer.id), entity: "beer", ...beer }, ConditionExpression: "attribute_not_exists(pk)" } },
    ],
    [new NameTaken()],
  );
}

export async function readBeer(id: string): Promise<StoredBeer | undefined> {
  const { Item } = await dynamo.send(new GetCommand({ TableName: tableName, Key: beerKey(id), ConsistentRead: true }));
  return Item && fromItem(Item);
}

export async function readBeers(style?: string): Promise<StoredBeer[]> {
  // A scan is fine for a catalogue of this size; add a GSI before it grows.
  const beers: StoredBeer[] = [];
  let start: Record<string, any> | undefined;
  do {
    const page = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        ExclusiveStartKey: start,
        FilterExpression: style ? "entity = :beer AND #style = :style" : "entity = :beer",
        ExpressionAttributeValues: { ":beer": "beer", ...(style ? { ":style": style } : {}) },
        ...(style ? { ExpressionAttributeNames: { "#style": "style" } } : {}),
      }),
    );
    beers.push(...(page.Items ?? []).map(fromItem));
    start = page.LastEvaluatedKey;
  } while (start);
  return beers;
}

export async function applyChanges(current: StoredBeer, changes: BeerChanges, updated_at: string): Promise<StoredBeer> {
  const next = { ...changes, updated_at };
  const fields = Object.keys(next);
  const update = {
    TableName: tableName,
    Key: beerKey(current.id),
    ConditionExpression: "attribute_exists(pk)",
    UpdateExpression: "SET " + fields.map((f) => `#${f} = :${f}`).join(", "),
    ExpressionAttributeNames: Object.fromEntries(fields.map((f) => [`#${f}`, f])),
    ExpressionAttributeValues: Object.fromEntries(Object.entries(next).map(([f, v]) => [`:${f}`, v])),
  };

  const renamed = changes.name !== undefined && nameKey(changes.name) !== nameKey(current.name);
  if (renamed) {
    await transact(
      [
        { Put: { TableName: tableName, Item: { ...lockKey(changes.name!), beer_id: current.id }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: update },
        { Delete: { TableName: tableName, Key: lockKey(current.name) } },
      ],
      [new NameTaken(), new BeerNotFound()],
    );
  } else {
    try {
      await dynamo.send(new UpdateCommand(update));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) throw new BeerNotFound();
      throw error;
    }
  }
  // Re-read rather than merge: ratings may have landed since `current` was read.
  const updated = await readBeer(current.id);
  if (!updated) throw new BeerNotFound();
  return updated;
}

export async function deleteBeer(beer: StoredBeer): Promise<void> {
  await transact(
    [
      { Delete: { TableName: tableName, Key: beerKey(beer.id), ConditionExpression: "attribute_exists(pk)" } },
      { Delete: { TableName: tableName, Key: lockKey(beer.name) } },
    ],
    [new BeerNotFound()],
  );
}

export async function addRating(id: string, score: number, updated_at: string): Promise<StoredBeer> {
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
    throw error;
  }
}

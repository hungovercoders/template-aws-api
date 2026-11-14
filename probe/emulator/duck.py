# Reads the probe bucket on AWS Emulator with DuckDB. Needs the emulator variables set; pip install duckdb pytz.
import duckdb, configparser, os, time
c = configparser.ConfigParser(); c.read(os.environ["AWS_SHARED_CREDENTIALS_FILE"]); d = c["default"]
con = duckdb.connect()
con.sql("install httpfs"); con.sql("load httpfs"); print("httpfs loaded, duckdb", duckdb.__version__)
def attempt(label, pre, secret_extra=""):
    con.sql("drop secret if exists s")
    try:
        for p in pre: con.sql(p)
        con.sql(f"create secret s (type s3, key_id '{d['aws_access_key_id']}', secret '{d['aws_secret_access_key']}', region 'us-east-1', endpoint '127.0.0.1:9297', url_style 'path', use_ssl true {secret_extra})")
        t=time.time(); r=con.sql("select count(*) from read_json('s3://probe-events/events/**/*.gz', format='newline_delimited', compression='gzip', hive_partitioning=true, union_by_name=true)").fetchall()
        print("OK  ", label, r, "%.2fs"%(time.time()-t)); return True
    except Exception as e: print("FAIL", label, "->", str(e).replace('\n',' ')[:230]); return False
ca=os.environ["AWS_CA_BUNDLE"]
ok = attempt("no CA setting", []) or attempt("ca_cert_file", [f"set ca_cert_file='{ca}'"]) or attempt("curl + ca_cert_file", ["set httpfs_client_implementation='curl'", f"set ca_cert_file='{ca}'"])
if ok:
    q="from read_json('s3://probe-events/events/**/*.gz', format='newline_delimited', compression='gzip', hive_partitioning=true, union_by_name=true)"
    print(con.sql(f"select type, dt, count(*) n, min(id) first_id, max(\"time\") last_time {q} group by all order by 1").fetchall())
    print(con.sql(f"describe select * {q}").fetchall())
    con.sql(f"create view events as select * {q}"); print("view:", con.sql("select id, data.n from events where type='probe.other.v1'").fetchall())
    print("glob:", [r[0][-60:] for r in con.sql("select file from glob('s3://probe-events/events/**')").fetchall()][:3])

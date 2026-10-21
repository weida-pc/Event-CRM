// A small bounded JSON store on SQLite; snapshots are blobs, not per-poll per-person writes.
export class Store {
  constructor(ctx) {
    this.ctx=ctx; this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS data (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  get(key, fallback=null) {
    const row=this.sql.exec('SELECT value FROM data WHERE key=?',key).toArray()[0];
    return row?JSON.parse(row.value):fallback;
  }
  put(key,value) {
    const body=JSON.stringify(value);
    if(new TextEncoder().encode(body).length>1_900_000) throw new Error('storage_payload_limit');
    this.sql.exec('INSERT INTO data(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,body);
  }
  remove(key) { this.sql.exec('DELETE FROM data WHERE key=?',key); }
  prefix(prefix) { return this.sql.exec('SELECT key,value FROM data WHERE key>=? AND key<? ORDER BY key',prefix,prefix+'\uffff').toArray().map(r=>[r.key,JSON.parse(r.value)]); }
  transaction(fn) { return this.ctx.storage.transactionSync(fn); }
}

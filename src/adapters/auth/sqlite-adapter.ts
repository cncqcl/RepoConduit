import { DatabaseSync } from 'node:sqlite';
import { errors, type Adapter, type AdapterPayload } from 'oidc-provider';

/** Durable oidc-provider adapter; all model state and secondary keys share one SQLite file. */
export function createSqliteOidcAdapter(db: DatabaseSync): (model: string) => Adapter {
  db.exec(`CREATE TABLE IF NOT EXISTS oidc_models (
    model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
    expires_at INTEGER, uid TEXT, user_code TEXT, grant_id TEXT,
    PRIMARY KEY (model, id)
  );
  CREATE INDEX IF NOT EXISTS oidc_models_uid ON oidc_models(model, uid);
  CREATE INDEX IF NOT EXISTS oidc_models_user_code ON oidc_models(model, user_code);
  CREATE INDEX IF NOT EXISTS oidc_models_grant_id ON oidc_models(grant_id);
  CREATE INDEX IF NOT EXISTS oidc_models_expiry ON oidc_models(expires_at);`);
  const now = () => Math.floor(Date.now() / 1000);
  const rowPayload = (row: unknown): AdapterPayload | undefined => {
    if (!row) return undefined;
    return JSON.parse((row as { payload: string }).payload) as AdapterPayload;
  };
  return (model) => ({
    async upsert(id, payload, expiresIn) {
      const expiry = expiresIn === undefined ? null : now() + expiresIn;
      db.prepare('DELETE FROM oidc_models WHERE expires_at IS NOT NULL AND expires_at<=?').run(now());
      db.prepare(`INSERT INTO oidc_models(model,id,payload,expires_at,uid,user_code,grant_id)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET
        payload=excluded.payload, expires_at=excluded.expires_at, uid=excluded.uid,
        user_code=excluded.user_code, grant_id=excluded.grant_id`)
        .run(model, id, JSON.stringify(payload), expiry, payload.uid ?? null,
          payload.userCode ?? null, payload.grantId ?? null);
    },
    async find(id) {
      return rowPayload(db.prepare(`SELECT payload FROM oidc_models WHERE model=? AND id=?
        AND (expires_at IS NULL OR expires_at>?)`).get(model, id, now()));
    },
    async findByUid(uid) {
      return rowPayload(db.prepare(`SELECT payload FROM oidc_models WHERE model=? AND uid=?
        AND (expires_at IS NULL OR expires_at>?)`).get(model, uid, now()));
    },
    async findByUserCode(userCode) {
      return rowPayload(db.prepare(`SELECT payload FROM oidc_models WHERE model=? AND user_code=?
        AND (expires_at IS NULL OR expires_at>?)`).get(model, userCode, now()));
    },
    async consume(id) {
      const changed = db.prepare(`UPDATE oidc_models SET payload=json_set(payload,'$.consumed',?)
        WHERE model=? AND id=? AND json_extract(payload,'$.consumed') IS NULL
        AND (expires_at IS NULL OR expires_at>?)`).run(now(), model, id, now()).changes;
      if (changed !== 1) throw new errors.InvalidGrant('Authorization code already consumed or unavailable');
    },
    async destroy(id) {
      db.prepare('DELETE FROM oidc_models WHERE model=? AND id=?').run(model, id);
    },
    async revokeByGrantId(grantId) {
      db.prepare('DELETE FROM oidc_models WHERE grant_id=?').run(grantId);
    },
  });
}

// الجداول الجديدة منفصلة لتطبيق نفس المخطط على القواعد الجديدة والقديمة بأمان.
export function initializeMessagingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL DEFAULT 'WHATSAPP',
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      recipient_role TEXT NOT NULL,
      recipient_name TEXT NOT NULL DEFAULT '',
      recipient_phone TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      body TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      error TEXT,
      trigger_source TEXT NOT NULL DEFAULT 'MANUAL',
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_message_log_dedupe
      ON message_log(kind, entity_type, entity_id, recipient_phone, created_at);
    CREATE INDEX IF NOT EXISTS idx_message_log_created_at ON message_log(created_at);
  `);
}

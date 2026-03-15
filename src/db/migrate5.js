const { pool } = require('./pool')
require('dotenv').config()

const SQL = `
-- ── Employee documents ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id        TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('passport','emirates_id','visa','license','iloe','national_id','other')),
  file_name     TEXT NOT NULL,
  drive_file_id TEXT,           -- Google Drive file ID
  drive_link    TEXT,           -- Shareable Google Drive link
  notes         TEXT,
  expires_at    DATE,
  uploaded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_docs_emp    ON employee_documents(emp_id);
CREATE INDEX IF NOT EXISTS idx_docs_type   ON employee_documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_docs_expiry ON employee_documents(expires_at);
`

async function migrate5() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v5 migrations...')
    await client.query(SQL)
    console.log('✅ v5 migrations complete')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}
migrate5()

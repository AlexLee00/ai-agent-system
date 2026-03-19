CREATE TABLE IF NOT EXISTS worker.expenses (
    id              SERIAL PRIMARY KEY,
    company_id      TEXT NOT NULL REFERENCES worker.companies(id),
    date            DATE NOT NULL DEFAULT CURRENT_DATE,
    category        TEXT,
    item_name       TEXT,
    amount          INTEGER NOT NULL,
    quantity        NUMERIC(12,2),
    unit_price      NUMERIC(12,2),
    note            TEXT,
    expense_type    TEXT NOT NULL DEFAULT 'variable',
    source_type     TEXT NOT NULL DEFAULT 'manual',
    source_file_id  INTEGER REFERENCES worker.documents(id),
    source_row_key  TEXT,
    registered_by   INTEGER REFERENCES worker.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_worker_expenses_company
    ON worker.expenses(company_id, date)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_worker_expenses_company_category
    ON worker.expenses(company_id, category, date)
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_expenses_source_row
    ON worker.expenses(company_id, source_file_id, source_row_key)
    WHERE deleted_at IS NULL
      AND source_file_id IS NOT NULL
      AND source_row_key IS NOT NULL;

COMMENT ON TABLE worker.expenses IS
  '워커 매입/지출 원장. 수동 입력, AI 제안, 엑셀 import를 공통 저장한다.';

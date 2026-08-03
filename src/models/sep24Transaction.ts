import { queryRead, queryWrite } from "../config/database";

export type Sep24TransactionKind = "deposit" | "withdrawal";

export type Sep24TransactionStatus =
  | "pending_user_transfer_start"
  | "pending_external"
  | "pending_anchor"
  | "pending_trust"
  | "pending_stellar"
  | "completed"
  | "failed"
  | "expired";

export interface Sep24Transaction {
  id: string;
  kind: Sep24TransactionKind;
  status: Sep24TransactionStatus;
  status_eta?: number;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  asset_in?: string;
  asset_out?: string;
  account?: string;
  memo?: string;
  memo_type?: "text" | "hash" | "id";
  from?: string;
  to?: string;
  callback?: string;
  message?: string;
  more_info_url?: string;
  created_at: string;
  completed_at?: string;
  updated_at?: string;
}

const ROW_TO_FIELD_MAP: Record<string, string> = {
  from_addr: "from",
  to_addr: "to",
};

function mapRow(row: any): Sep24Transaction | null {
  if (!row) return null;
  const tx: Record<string, any> = {};
  for (const key of Object.keys(row)) {
    const field = ROW_TO_FIELD_MAP[key] || key;
    tx[field] = row[key];
  }
  return tx as Sep24Transaction;
}

const SELECT_COLUMNS = `
  id, kind, status, status_eta,
  amount_in, amount_out, amount_fee,
  asset_in, asset_out,
  account, memo, memo_type,
  from_addr, to_addr,
  callback, message, more_info_url,
  created_at, completed_at, updated_at
`;

export class Sep24TransactionModel {
  async create(data: Omit<Sep24Transaction, "id" | "created_at" | "updated_at">): Promise<Sep24Transaction> {
    const result = await queryWrite(
      `INSERT INTO sep24_transactions (
        kind, status, status_eta,
        amount_in, amount_out, amount_fee,
        asset_in, asset_out,
        account, memo, memo_type,
        from_addr, to_addr,
        callback, message, more_info_url
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING ${SELECT_COLUMNS}`,
      [
        data.kind,
        data.status,
        data.status_eta ?? null,
        data.amount_in ?? null,
        data.amount_out ?? null,
        data.amount_fee ?? null,
        data.asset_in ?? null,
        data.asset_out ?? null,
        data.account ?? null,
        data.memo ?? null,
        data.memo_type ?? null,
        data.from ?? null,
        data.to ?? null,
        data.callback ?? null,
        data.message ?? null,
        data.more_info_url ?? null,
      ],
    );
    return mapRow(result.rows[0])!;
  }

  async findById(id: string): Promise<Sep24Transaction | null> {
    const result = await queryRead(
      `SELECT ${SELECT_COLUMNS} FROM sep24_transactions WHERE id = $1`,
      [id],
    );
    return mapRow(result.rows[0]);
  }

  async updateStatus(id: string, status: Sep24TransactionStatus, message?: string): Promise<Sep24Transaction | null> {
    const setClauses = ["status = $1", "updated_at = CURRENT_TIMESTAMP"];
    const params: any[] = [status];
    let paramIndex = 2;

    if (message !== undefined) {
      setClauses.push(`message = $${paramIndex++}`);
      params.push(message);
    }

    if (status === "completed" || status === "failed" || status === "expired") {
      setClauses.push(`completed_at = $${paramIndex++}`);
      params.push(new Date().toISOString());
    }

    params.push(id);
    const result = await queryWrite(
      `UPDATE sep24_transactions SET ${setClauses.join(", ")} WHERE id = $${paramIndex}
       RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    return mapRow(result.rows[0]);
  }

  async updateTransaction(id: string, updates: Partial<Sep24Transaction>): Promise<Sep24Transaction | null> {
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    const fieldToColumn: Record<string, string> = {
      from: "from_addr",
      to: "to_addr",
    };

    const allowedFields = [
      "status", "status_eta", "amount_in", "amount_out", "amount_fee",
      "asset_in", "asset_out", "account", "memo", "memo_type",
      "from", "to", "callback", "message", "more_info_url",
    ];

    for (const [field, value] of Object.entries(updates)) {
      if (!allowedFields.includes(field)) continue;
      if (value === undefined) continue;
      const column = fieldToColumn[field] || field;
      setClauses.push(`${column} = $${paramIndex++}`);
      params.push(value);
    }

    if (setClauses.length === 0) return this.findById(id);

    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);

    if (updates.status && ["completed", "failed", "expired"].includes(updates.status)) {
      setClauses.push(`completed_at = $${paramIndex++}`);
      params.push(new Date().toISOString());
    }

    params.push(id);
    const result = await queryWrite(
      `UPDATE sep24_transactions SET ${setClauses.join(", ")} WHERE id = $${paramIndex}
       RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    return mapRow(result.rows[0]);
  }

  async findByStatus(status: Sep24TransactionStatus): Promise<Sep24Transaction[]> {
    const result = await queryRead(
      `SELECT ${SELECT_COLUMNS} FROM sep24_transactions WHERE status = $1 ORDER BY created_at DESC`,
      [status],
    );
    return result.rows.map(mapRow).filter(Boolean) as Sep24Transaction[];
  }
}

export const sep24TransactionModel = new Sep24TransactionModel();

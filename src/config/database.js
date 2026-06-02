/**
 * config/database.js
 * اتصال PostgreSQL عبر Connection Pool
 * يدعم المعاملات (Transactions) ويُغلق الاتصال عند الخطأ تلقائياً
 */

import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'qatifan_fund',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD,
  max:      20,          // أقصى عدد اتصالات متزامنة
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error('خطأ غير متوقع في pool الاتصالات', { error: err.message });
});

/**
 * تنفيذ استعلام عادي
 * @param {string} text  - نص SQL
 * @param {Array}  params - المعاملات
 */
export async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    logger.debug('SQL query', { duration: Date.now() - start, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('فشل تنفيذ الاستعلام', { query: text, params, error: err.message });
    throw err;
  }
}

/**
 * تنفيذ عمليات داخل معاملة (Transaction) مع Rollback تلقائي عند الفشل
 * @param {Function} fn - دالة تستقبل client وتنفّذ العمليات
 * @returns نتيجة الدالة
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('تم تراجع المعاملة (Rollback)', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

export default pool;

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from '../config/database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'qatifan-secret-2025';

// 1. Member Login
export async function loginMember(username, password) {
  const cleanUsername = username.trim();

  const result = await query(`
    SELECT id, full_name, email, total_debt, membership_status, password_hash
    FROM members 
    WHERE username = $1 AND membership_status = 'active'
  `, [cleanUsername]);

  if (result.rows.length === 0) {
    throw new Error('اسم المستخدم غير مسجل أو العضوية غير نشطة');
  }

  const member = result.rows[0];

  // Compare provided password with hashed password in DB
  const isValidPassword = await bcrypt.compare(password, member.password_hash);
  
  if (!isValidPassword) {
    throw new Error('كلمة المرور غير صحيحة');
  }

  // Remove hash from the member object before sending it to frontend
  delete member.password_hash;

  const token = jwt.sign(
    { memberId: member.id, fullName: member.full_name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return { token, member };
}

// 2. Admin Login
export async function loginAdmin(username, password) {
  // Hardcoded Admin credentials (you can move these to .env later)
  const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin2026';

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign(
      { role: 'admin', memberId: 'admin_001' },
      JWT_SECRET,
      { expiresIn: '1d' }
    );
    return { token };
  }

  throw new Error('بيانات الدخول الخاصة بالإدارة غير صحيحة');
}

// Middleware to verify Token
export function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  }
  try {
    const token = authHeader.split(' ')[1];
    req.member = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'الجلسة منتهية — سجّل الدخول مجدداً' });
  }
}
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from '../config/database.js';

// دالة تسجيل دخول العضو
export const loginMember = async (username, password) => {
  const result = await query(`SELECT * FROM members WHERE phone_number = $1`, [username]);
  if (result.rows.length === 0) throw new Error("بيانات الدخول غير صحيحة");
  
  const member = result.rows[0];
  const isMatch = await bcrypt.compare(password, member.password_hash);
  if (!isMatch) throw new Error("كلمة المرور غير صحيحة");

  const token = jwt.sign({ id: member.id, role: member.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  return { token, member };
};

// دالة تسجيل دخول المدير
export const loginAdmin = async (username, password) => {
  const result = await query(`SELECT * FROM members WHERE phone_number = $1 AND role = 'admin'`, [username]);
  if (result.rows.length === 0) throw new Error("غير مصرح لك بالدخول كمدير");
  
  const member = result.rows[0];
  const isMatch = await bcrypt.compare(password, member.password_hash);
  if (!isMatch) throw new Error("كلمة المرور غير صحيحة");

  const token = jwt.sign({ id: member.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  return { token, member };
};

// Middleware للتحقق من صحة الـ Token
export const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: "لم يتم تقديم رمز الدخول" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // يتم تخزين بيانات المستخدم (id, role)
    next();
  } catch (err) {
    res.status(401).json({ error: "رمز الدخول غير صالح" });
  }
};

// Middleware للتحقق من صلاحية المدير (Admin Only)
export const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: "صلاحيات مرفوضة: هذا الإجراء مخصص لمدير النظام فقط" });
  }
};
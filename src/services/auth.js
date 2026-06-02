import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';
import { sendWhatsApp } from './notificationService.js';

const JWT_SECRET = process.env.JWT_SECRET || 'qatifan-secret-2025';
const otpStore = new Map(); // مؤقت — في الإنتاج استخدم Redis

// توليد OTP عشوائي 6 أرقام
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// الخطوة 1: طلب OTP
export async function requestOTP(phoneNumber) {
  // تحقق من وجود العضو
  const result = await query(`
    SELECT id, full_name, phone_country_code, phone_number
    FROM members
    WHERE phone_country_code || phone_number = $1
      AND membership_status != 'inactive'
  `, [phoneNumber]);

  if (result.rows.length === 0) {
    throw new Error('رقم الجوال غير مسجّل في النظام');
  }

  const member = result.rows[0];
  const otp = generateOTP();
  const expiry = Date.now() + 5 * 60 * 1000; // 5 دقائق

  // حفظ OTP مؤقتاً
  otpStore.set(phoneNumber, { otp, expiry, memberId: member.id });

  // إرسال OTP عبر واتساب
  await sendWhatsApp(
    phoneNumber,
    `رمز التحقق الخاص بكم في صندوق عائلة قطيفان:\n\n*${otp}*\n\nصالح لمدة 5 دقائق. لا تشاركه مع أحد.`
  );

  return { success: true, message: 'تم إرسال رمز التحقق' };
}

// الخطوة 2: التحقق من OTP وإصدار Token
export async function verifyOTP(phoneNumber, otp) {
  const stored = otpStore.get(phoneNumber);
  if (!stored) throw new Error('لم يتم طلب رمز تحقق لهذا الرقم');
  if (Date.now() > stored.expiry) {
    otpStore.delete(phoneNumber);
    throw new Error('انتهت صلاحية رمز التحقق — اطلب رمزاً جديداً');
  }
  if (stored.otp !== otp) throw new Error('رمز التحقق غير صحيح');

  // حذف OTP بعد الاستخدام
  otpStore.delete(phoneNumber);

  // جلب بيانات العضو
  const result = await query(`
    SELECT id, full_name, email, total_debt, membership_status
    FROM members WHERE id = $1
  `, [stored.memberId]);

  const member = result.rows[0];

  // إصدار JWT Token
  const token = jwt.sign(
    { memberId: member.id, fullName: member.full_name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return { token, member };
}

// Middleware للتحقق من Token
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
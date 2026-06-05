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
  // Use the exact number provided, just strip accidental blank spaces
  const cleanNumber = phoneNumber.trim();

  // استعلام "مدرع" لتجاوز حساسية أنواع البيانات في Postgres
  const result = await query(`
    SELECT id, full_name
    FROM members
    WHERE CAST(phone_number AS TEXT) = $1
      AND CAST(membership_status AS TEXT) = 'active'
  `, [cleanNumber]);

  if (result.rows.length === 0) {
    throw new Error('رقم الجوال غير مسجّل في النظام أو العضوية غير نشطة');
  }

  const member = result.rows[0];
  const otp = generateOTP();
  const expiry = Date.now() + 5 * 60 * 1000; // 5 دقائق

  // حفظ OTP مؤقتاً
  otpStore.set(cleanNumber, { otp, expiry, memberId: member.id });

  // طباعة الرمز في شاشة Railway لتسهيل الدخول
  console.log(`\n=========================================`);
  console.log(`🔐 كود الدخول للعضو ${member.full_name}: ${otp}`);
  console.log(`=========================================\n`);

  try {
    await sendWhatsApp(
      phoneNumber,
      `رمز التحقق الخاص بكم في صندوق عائلة قطيفان:\n\n*${otp}*\n\nصالح لمدة 5 دقائق. لا تشاركه مع أحد.`
    );
  } catch (error) {
    console.warn('⚠️ تعذر إرسال رسالة الواتساب، يرجى مراجعة إعدادات خدمة الإشعارات.');
  }

  return { success: true, message: 'تم إرسال رمز التحقق' };
}

// الخطوة 2: التحقق من OTP وإصدار Token
export async function verifyOTP(phoneNumber, otp) {
  // Must match the exact formatting used in requestOTP
  const cleanNumber = phoneNumber.trim();

  const stored = otpStore.get(cleanNumber);
  if (!stored) throw new Error('لم يتم طلب رمز تحقق لهذا الرقم');
  if (Date.now() > stored.expiry) {
    otpStore.delete(cleanNumber);
    throw new Error('انتهت صلاحية رمز التحقق — اطلب رمزاً جديداً');
  }
  if (stored.otp !== otp) throw new Error('رمز التحقق غير صحيح');

  // حذف OTP بعد الاستخدام
  otpStore.delete(cleanNumber);

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
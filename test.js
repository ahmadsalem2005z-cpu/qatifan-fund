import 'dotenv/config';
import { sendEmail } from './src/services/notificationService.js';

console.log('Testing email...');
try {
  const result = await sendEmail(
    process.env.SMTP_USER,
    'اختبار — صندوق عائلة قطيفان',
    `<div dir="rtl" style="font-family:Arial;padding:20px">
      <h2>اختبار نظام البريد</h2>
      <p>هذا بريد تجريبي من نظام صندوق عائلة قطيفان</p>
      <p>إذا وصلك هذا البريد فالنظام يعمل بنجاح ✅</p>
    </div>`
  );
  console.log('✅ Email sent!', result.messageId);
} catch (err) {
  console.error('❌ Error:', err.message);
}
process.exit(0);
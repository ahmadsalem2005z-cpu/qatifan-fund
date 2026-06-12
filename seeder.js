import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pkg from 'pg';
const { Pool } = pkg;

// إنشاء اتصال مستقل بقاعدة البيانات (لكي لا يعتمد على ملفات أخرى)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const query = (text, params) => pool.query(text, params);

// كلمة المرور المشفرة لـ "123456" لتوفير وقت المعالجة
const DEFAULT_PASSWORD_HASH = '$2a$10$vI8aWBnW3fID.ZQ4/zo1G.q1lRps.9cGLcZEiGDMvr5yUP1KUOWTa'; 

const generateTestUsers = () => {
    const users = [];
    
    // ── 1. حالات اختبار متطرفة (15 مستخدم) ──
    users.push({ name: "Perfect Payer", phone: "0790000001", branch: "الفرع الأول", debt: 0, date: "2026-06-01", status: "active" });
    users.push({ name: "Heavy Defaulter", phone: "0790000002", branch: "الفرع الثاني", debt: 50000.00, date: "2010-01-01", status: "active" });
    users.push({ name: "Future Whale", phone: "0790000003", branch: "الفرع الثالث", debt: 0, date: "2040-12-31", status: "active" });
    users.push({ name: "The Ghost (Nulls)", phone: "0790000004", branch: "غير محدد", debt: 0, date: null, status: "active" });
    users.push({ name: "Fractional Debt", phone: "0790000005", branch: "الفرع الأول", debt: 12.50, date: "2025-05-15", status: "active" });
    users.push({ name: "Archived Clean", phone: "0790000006", branch: "الفرع الثاني", debt: 0, date: "2026-01-01", status: "archived" });
    users.push({ name: "Archived Defaulter", phone: "0790000007", branch: "الفرع الثالث", debt: 450, date: "2018-05-01", status: "archived" });
    users.push({ name: "Leap Year Payer", phone: "0790000008", branch: "الفرع الأول", debt: 0, date: "2024-02-29", status: "active" });
    users.push({ name: "Robert'); DROP TABLE members;--", phone: "0790000009", branch: "Hacker Branch", debt: 0, date: "2026-01-01", status: "active" });
    users.push({ name: "<script>alert('XSS')</script>", phone: "0790000010", branch: "XSS Branch", debt: 100, date: "2026-01-01", status: "active" });
    users.push({ name: "Emoji King 👑💸👨‍👩‍👧‍👦🔥", phone: "0790000011", branch: "الفرع الأول", debt: 10, date: "2026-01-01", status: "active" });
    users.push({ name: "A".repeat(250), phone: "0790000012", branch: "Long Text Branch", debt: 0, date: "2026-01-01", status: "active" });
    users.push({ name: "    Whitespace User    ", phone: "0790000013", branch: "الفرع الثاني", debt: 0, date: "2026-01-01", status: "active" });
    users.push({ name: "Zero Value String", phone: "00000000000", branch: "الفرع الثالث", debt: 0, date: "2026-01-01", status: "active" });
    users.push({ name: "Admin Test Account", phone: "0799999999", branch: "الإدارة", debt: 0, date: "2026-06-01", status: "active", role: "admin" });

    // ── 2. توليد عشوائي لباقي المستخدمين (85 مستخدم) ──
    const branches = ["الفرع الأول", "الفرع الثاني", "الفرع الثالث", "الفرع الرابع", "غير محدد"];
    const statuses = ["active", "active", "active", "active", "archived"]; // 80% نشط
    
    for (let i = 16; i <= 100; i++) {
        const isDefaulter = Math.random() > 0.4; // 60% احتمالية وجود ديون
        const randomDebt = isDefaulter ? Math.floor(Math.random() * 500) + 2 : 0;
        
        const start = new Date(2018, 0, 1).getTime();
        const end = new Date(2028, 0, 1).getTime();
        const randomDate = new Date(start + Math.random() * (end - start)).toISOString().split('T')[0];

        users.push({
            name: `عضو اختبار تجريبي رقم ${i}`,
            phone: `077${String(i).padStart(7, '0')}`,
            branch: branches[Math.floor(Math.random() * branches.length)],
            debt: randomDebt,
            date: isDefaulter ? randomDate : (Math.random() > 0.1 ? randomDate : null),
            status: statuses[Math.floor(Math.random() * statuses.length)],
            role: "member"
        });
    }

    return users;
};

const runSeeder = async () => {
    console.log("🚀 Starting the Qatifan Fund Test Data Seeder...");
    const users = generateTestUsers();
    let successCount = 0;
    let failCount = 0;

    for (let user of users) {
        try {
            // 💡 تم إزالة سطر ON CONFLICT لكي يتم الإدخال بقوة
            await query(`
                INSERT INTO members (full_name, phone_number, password_hash, family_branch, total_debt, last_paid_date, membership_status, role, username)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [
                user.name, 
                user.phone, 
                DEFAULT_PASSWORD_HASH, 
                user.branch, 
                user.debt, 
                user.date, 
                user.status, 
                user.role || 'member', 
                user.phone
            ]);
            successCount++;
            process.stdout.write("█"); 
        } catch (error) {
            failCount++;
            console.error(`\n❌ Failed to insert: ${user.name} - ${error.message}`);
        }
    }

    console.log(`\n\n✅ Seeding Complete! Successfully injected ${successCount} users. Failed: ${failCount}.`);
    console.log("🔑 يمكنك تسجيل الدخول باستخدام أي رقم من المولدين بكلمة مرور: 123456");
    
    await pool.end();
    process.exit();
};

runSeeder();
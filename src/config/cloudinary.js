import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import multer from 'multer';
import 'dotenv/config';

// 1. إعداد الاتصال باستخدام المتغيرات السرية
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// 2. إعدادات التخزين
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'qatifan_receipts',
    allowedFormats: ['jpeg', 'png', 'jpg', 'pdf'],
  },
});

// 3. تصدير أداة الرفع
const upload = multer({ storage: storage });

export default upload;
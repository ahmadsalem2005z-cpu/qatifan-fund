import 'dotenv/config';
import { scheduleMonthlyCron } from './jobs/generateMonthlyDues.js';
import { scheduleReminderCron } from './jobs/sendAutomatedReminders.js';
import { logger } from './utils/logger.js';

scheduleMonthlyCron();
scheduleReminderCron();
logger.info('Qatifan Fund System started successfully');
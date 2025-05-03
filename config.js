require('dotenv').config();

module.exports = {
  token: process.env.TELEGRAM_TOKEN || '7656406296:AAGJjGq64TimQpW37Jbpt2LSDkIcC5OJxdg',
  id: process.env.TELEGRAM_USER_ID || '7221092264',
  surya: process.env.TELEGRAM_NOTIFICATION_ID || '',
  address: process.env.SERVER_ADDRESS || 'https://www.google.com',
  enableSurya: process.env.ENABLE_SURYA === 'true' || false
};

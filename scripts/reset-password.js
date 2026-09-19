// Resets the dashboard login (password + all sessions), for when you've
// forgotten the password. Does NOT touch providers, accounts, or routes —
// only the dashboard's own auth state. Run: npm run reset-password
const { db } = require('../lib/db');

db.prepare("DELETE FROM settings WHERE key IN ('dashboard_password_hash', 'session_secret')").run();
console.log('Dashboard password reset. Start the server and open the dashboard to set a new one.');

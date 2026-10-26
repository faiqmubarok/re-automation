import { setupAuth, storeToken } from './google-drive.js';
import dotenv from 'dotenv';
import readline from 'readline';
import fs from 'fs';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function setup() {
  console.log('🔐 Google Drive Authentication Setup\n');
  
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';
  
  // Check if credentials file exists
  if (!fs.existsSync(credentialsPath)) {
    console.log('❌ credentials.json not found!');
    console.log('\n📝 To get your credentials:');
    console.log('1. Go to: https://console.cloud.google.com/');
    console.log('2. Create a new project (or select existing)');
    console.log('3. Enable Google Drive API');
    console.log('4. Go to "Credentials" → Create Credentials → OAuth client ID');
    console.log('5. Application type: Desktop app');
    console.log('6. Download the JSON file and save it as "credentials.json"');
    console.log(`7. Place it in: ${credentialsPath}\n`);
    rl.close();
    return;
  }
  
  try {
    const { oAuth2Client, authUrl } = await setupAuth(credentialsPath);
    
    console.log('📋 Langkah 1: Buka URL ini di browser:\n');
    console.log(authUrl);
    console.log('\n------------------------------------------------------------');
    console.log('💡 TIPS:');
    console.log('1. Login dengan akun Google dan klik "Continue" / "Lanjutkan".');
    console.log('2. Browser akan diarahkan ke http://localhost/?code=...');
    console.log('3. Jika muncul "This site can’t be reached" di browser, itu NORMAL!');
    console.log('4. Cukup COPY seluruh URL dari address bar browser (atau kode setelah code=),');
    console.log('   lalu PASTE di bawah ini.');
    console.log('------------------------------------------------------------\n');
    
    const code = await question('📥 Langkah 2: Paste kode otorisasi atau URL lengkap dari browser: ');
    
    console.log('\n⏳ Verifying and storing token...');
    await storeToken(oAuth2Client, code);
    
    console.log('✅ Authentication successful!');
    console.log('✅ token.json has been created');
    console.log('\n🎉 Setup complete! You can now run: npm run start-manual\n');
    
  } catch (error) {
    console.error('❌ Error during setup:', error.message);
  }
  
  rl.close();
}

setup();

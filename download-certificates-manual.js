import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { authorize, uploadFile } from './google-drive.js';
import data from './data.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Konfigurasi dari .env
const LOGIN_URL = process.env.LOGIN_URL;
const USERNAME = process.env.MOODLE_USERNAME;
const PASSWORD = process.env.MOODLE_PASSWORD;
const CLASS_URL = process.env.CLASS_URL;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

// Buat folder downloads kalau belum ada
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

/**
 * Login as admin (with retry logic for connection issues)
 */
async function loginAsAdmin(page) {
  console.log('🔐 Logging in as admin...');

  // Retry navigation in case of ERR_CONNECTION_CLOSED or chrome-error state
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    } catch (e) {
      console.log(`   ⚠️  Login page navigation attempt ${attempt}/3 failed: ${e.message.split('\n')[0]}`);
      if (attempt < 3) {
        await page.waitForTimeout(3000);
      } else {
        throw e;
      }
    }
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1000);

  // Check if we're actually on the login page (might already be logged in)
  const hasLoginForm = await page.locator('#username').count();
  if (hasLoginForm === 0) {
    console.log('✅ Already logged in as admin');
    return;
  }

  await page.fill('#username', USERNAME);
  await page.fill('#password', PASSWORD);
  await page.locator('form:has(#username) button[type="submit"]').click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  console.log('✅ Logged in as admin');
}

/**
 * Return to admin account after "Log in as" student
 * 
 * Debug findings:
 * - loginas.php ends the impersonation and redirects to /login/index.php (session destroyed)
 * - The login page has "Log in as a guest" and "Log in" buttons
 * - We must NOT click any buttons on the login page (old code was clicking "Log in as a guest"!)
 * - Sometimes loginas.php causes ERR_CONNECTION_CLOSED
 * - Solution: just navigate to loginas.php (ignore errors), then always re-login
 */
async function returnToAdmin(page) {
  console.log('🔄 Returning to admin account...');

  // Step 1: End the impersonation via loginas.php
  // This will destroy the session and redirect to login page
  // ERR_CONNECTION_CLOSED can happen here - that's fine, session is still ended
  try {
    const returnLink = page.locator('a[href*="loginas.php"]').first();
    if (await returnLink.count() > 0) {
      const href = await returnLink.getAttribute('href');
      if (href) {
        console.log(`   📍 Ending impersonation: ${href}`);
        try {
          await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (navError) {
          // ERR_CONNECTION_CLOSED is common here - the impersonation is still ended
          console.log(`   ⚠️  Navigation hiccup (expected): ${navError.message.split('\n')[0]}`);
        }
        await page.waitForTimeout(2000);
      }
    }
  } catch (e) {
    console.log(`   ⚠️  Could not find return link: ${e.message.split('\n')[0]}`);
  }

  // Step 2: Always re-login as admin (session is destroyed after loginas.php)
  // Do NOT click any buttons on the current page - it's the login page with "Log in as a guest"!
  console.log('   🔐 Re-logging in as admin...');
  await loginAsAdmin(page);
}

/**
 * Go to participants page, show all, and search for a student
 * All in one function to avoid page reload issues
 */
async function goToParticipantsAndSearch(page, studentName) {
  const classUrl = new URL(CLASS_URL);
  const courseId = classUrl.searchParams.get('id');
  const participantsUrl = `${classUrl.origin}/user/index.php?id=${courseId}`;

  // Step 1: Navigate to participants page
  console.log(`👥 Navigating to participants page...`);
  await page.goto(participantsUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  // Step 2: Click "Show all" if it exists (may not exist if already showing all)
  const showAllLink = page.locator('a:has-text("Show all")').first();
  if (await showAllLink.count() > 0) {
    console.log(`📋 Clicking "Show all"...`);
    await showAllLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
  }

  // Step 3: Search using the search field on the current page
  console.log(`   🔍 Searching for: ${studentName}`);
  const searchInput = page.locator('input[name="search"]').first();
  if (await searchInput.count() > 0) {
    await searchInput.fill(studentName);
    await searchInput.press('Enter');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
  }

  // Step 4: Find and click the student name in the results
  const studentLink = page.locator(`a:has-text("${studentName}")`).first();
  if (await studentLink.count() > 0) {
    console.log(`   ✅ Found student, opening profile...`);
    await studentLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    return;
  }

  throw new Error(`Student "${studentName}" not found in participants list`);
}

/**
 * From the student profile page, click "Details" tab then "Log in as"
 */
async function loginAsStudentFromProfile(page, studentName) {
  // On profile page, click "Details" tab if it exists
  console.log(`   📋 Looking for "Details" tab...`);
  const detailsTab = page.locator('a:has-text("Details"), button:has-text("Details"), [role="tab"]:has-text("Details")').first();
  if (await detailsTab.count() > 0) {
    await detailsTab.click();
    await page.waitForTimeout(1000);
    console.log(`   ✅ Clicked "Details" tab`);
  }

  // Find and click "Log in as" link/button
  console.log(`   🔑 Looking for "Log in as"...`);
  const loginAsLink = page.locator('a:has-text("Log in as"), a:has-text("log in as"), a[href*="loginas"]').first();

  if (await loginAsLink.count() > 0) {
    await loginAsLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Confirmation page - click "Continue"
    const continueBtn = page.locator('input[type="submit"][value="Continue"], button:has-text("Continue"), input[type="submit"]').first();
    if (await continueBtn.count() > 0) {
      console.log(`   ✅ Confirming "Log in as"...`);
      await continueBtn.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);
    }

    console.log(`   ✅ Now logged in as ${studentName}`);
  } else {
    throw new Error(`"Log in as" link not found on profile page`);
  }
}

/**
 * Download certificate as the logged-in student
 * Flow: class page → click certificate activity → click "View certificate" → download PDF
 */
async function downloadCertificateAsStudent(page, studentName) {
  // Go to class page
  console.log(`   📄 Navigating to class page...`);
  await page.goto(CLASS_URL);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  // Find "View certificate" button/link on the class page
  console.log(`   🎓 Looking for "View certificate" button...`);
  let viewCertBtn = page.locator('a:has-text("View certificate"), button:has-text("View certificate"), a:has-text("View Certificate")').first();

  // Fallback: look for certificate activity link (mod/customcert)
  if (await viewCertBtn.count() === 0) {
    console.log(`   🔄 "View certificate" not found, trying certificate activity link...`);
    viewCertBtn = page.locator('a[href*="mod/customcert/view.php"]').first();
  }

  // Fallback: look for any element with "certificate" text
  if (await viewCertBtn.count() === 0) {
    viewCertBtn = page.locator('.activity:has-text("Certificate"), .modtype_customcert, [class*="customcert"]').first();
  }

  if (await viewCertBtn.count() === 0) {
    await page.screenshot({ path: path.join(DOWNLOAD_DIR, `debug-class-page.png`), fullPage: true });
    throw new Error('Certificate activity not found on class page');
  }

  console.log(`   ✅ Found certificate button, clicking...`);
  await viewCertBtn.click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  // Now on the certificate page - find the "View certificate" download button/link
  console.log(`   📥 Looking for "View certificate" button on certificate page...`);

  // The current page URL should be like: /mod/customcert/view.php?id=7044
  // The download URL is the same URL + &downloadown=1 (standard Moodle customcert pattern)
  const currentUrl = page.url();
  console.log(`   📍 Current page URL: ${currentUrl}`);

  let downloadUrl = null;

  // First, try to find a link/button with downloadown in href
  const downloadownLink = page.locator('a[href*="downloadown"]').first();
  if (await downloadownLink.count() > 0) {
    downloadUrl = await downloadownLink.getAttribute('href');
    console.log(`   ✅ Found downloadown link: ${downloadUrl}`);
  }

  // If not found, construct URL from current page URL + downloadown=1
  if (!downloadUrl && currentUrl.includes('mod/customcert/view.php')) {
    const urlObj = new URL(currentUrl);
    urlObj.searchParams.set('downloadown', '1');
    downloadUrl = urlObj.toString();
    console.log(`   ✅ Constructed download URL: ${downloadUrl}`);
  }

  // If still not found, try "View certificate" button href
  if (!downloadUrl) {
    const viewCertLink = page.locator('a:has-text("View certificate"), a:has-text("View Certificate")').first();
    if (await viewCertLink.count() > 0) {
      downloadUrl = await viewCertLink.getAttribute('href');
      if (downloadUrl) {
        console.log(`   ✅ Found "View certificate" link: ${downloadUrl}`);
      }
    }
  }

  if (!downloadUrl) {
    // Take screenshot for debugging
    await page.screenshot({ path: path.join(DOWNLOAD_DIR, `debug-cert-page-${studentName.replace(/\s+/g, '_')}.png`), fullPage: true });
    throw new Error('No download URL found on certificate page');
  }

  // Download the PDF using page.request (same as admin script)
  // This opens a link that generates the PDF (server is slow, so long timeout)
  console.log(`   ⏳ Downloading certificate... (server may take a while, please wait)`);

  const response = await page.request.get(downloadUrl, {
    timeout: 300000 // 5 minutes timeout
  });

  console.log(`   📡 HTTP Status: ${response.status()}`);
  console.log(`   📋 Content-Type: ${response.headers()['content-type']}`);

  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} - Download failed`);
  }

  const buffer = await response.body();
  console.log(`   📦 Downloaded ${buffer.length} bytes`);

  // Verify it's a PDF
  const contentType = response.headers()['content-type'] || '';
  if (contentType.includes('text/html')) {
    console.error(`   ❌ Got HTML instead of PDF`);
    console.log(`   📝 First 300 chars: ${buffer.toString('utf8').substring(0, 300)}`);
    throw new Error('Got HTML instead of PDF - certificate may not be available');
  }

  if (buffer.length < 1000) {
    throw new Error(`File too small (${buffer.length} bytes) - probably not a valid certificate`);
  }

  // Save the file
  const sanitizedName = studentName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .trim();

  const filename = `${sanitizedName}.pdf`;
  const savePath = path.join(DOWNLOAD_DIR, filename);

  fs.writeFileSync(savePath, buffer);
  console.log(`   ✅ Saved: ${filename} (${buffer.length} bytes)`);

  return { filename, savePath };
}

/**
 * Main function
 */
async function downloadCertificatesManual() {
  console.log('🚀 Starting manual certificate download...');
  console.log(`📋 Total students to process: ${data.length}\n`);

  // Validate config
  if (!CLASS_URL) {
    console.error('❌ CLASS_URL not set in .env file!');
    process.exit(1);
  }

  // Check Google Drive
  const useGoogleDrive = GOOGLE_DRIVE_FOLDER_ID && fs.existsSync(GOOGLE_CREDENTIALS_PATH) && fs.existsSync('token.json');
  let driveAuth = null;
  if (useGoogleDrive) {
    try {
      driveAuth = await authorize(GOOGLE_CREDENTIALS_PATH);
      console.log('✅ Google Drive connected\n');
    } catch (error) {
      console.log('⚠️  Google Drive not configured. Files will be saved locally only.\n');
    }
  } else {
    console.log('⚠️  Google Drive not configured. Files will be saved locally only.\n');
  }

  // Launch browser
  const browser = await chromium.launch({
    headless: false, // Show browser window
  });

  const context = await browser.newContext({ acceptDownloads: true });
  context.setDefaultTimeout(120000); // 2 min default timeout
  const page = await context.newPage();

  let successCount = 0;
  let errorCount = 0;
  const startTime = Date.now();

  // Login as admin first
  await loginAsAdmin(page);

  for (let i = 0; i < data.length; i++) {
    const studentName = data[i];
    console.log(`\n📥 [${i + 1}/${data.length}] Processing: ${studentName}`);

    let downloadResult = null;

    try {
      // Go to participants page, show all, and search for student
      await goToParticipantsAndSearch(page, studentName);

      // From profile page, click Details → Log in as → Continue
      await loginAsStudentFromProfile(page, studentName);

      // Download certificate as student
      downloadResult = await downloadCertificateAsStudent(page, studentName);

      // Upload to Google Drive if configured
      if (driveAuth && GOOGLE_DRIVE_FOLDER_ID && downloadResult) {
        try {
          console.log(`   ☁️  Uploading to Google Drive...`);
          const uploadResult = await uploadFile(driveAuth, downloadResult.savePath, downloadResult.filename, GOOGLE_DRIVE_FOLDER_ID);

          if (uploadResult.success) {
            console.log(`   ✅ Uploaded to Drive: ${uploadResult.webViewLink}`);
          } else {
            console.log(`   ⚠️  Drive upload failed: ${uploadResult.error}`);
          }
        } catch (uploadError) {
          console.log(`   ⚠️  Drive upload error: ${uploadError.message}`);
        }
      }

      successCount++;
      console.log(`   ✅ Done: ${studentName}`);

    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
      errorCount++;

      // Take screenshot for debugging
      try {
        await page.screenshot({
          path: path.join(DOWNLOAD_DIR, `error-${i + 1}-${studentName.replace(/\s+/g, '_')}.png`),
          fullPage: true
        });
        console.log(`   📸 Screenshot saved for debugging`);
      } catch (e) { /* ignore screenshot errors */ }
    }

    // Return to admin account after each student
    try {
      await returnToAdmin(page);
    } catch (error) {
      console.error(`   ⚠️  Return to admin failed: ${error.message}`);
      // Try full re-login as fallback
      try {
        console.log('   🔄 Attempting full re-login...');
        await page.goto(LOGIN_URL);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1000);
        await loginAsAdmin(page);
      } catch (loginError) {
        console.error(`   ❌ Re-login failed: ${loginError.message}`);
      }
    }

    // Progress summary
    if ((i + 1) % 5 === 0 || i === data.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const avgTime = (Date.now() - startTime) / (i + 1) / 1000;
      const remaining = data.length - (i + 1);
      const estMin = (remaining * avgTime / 60).toFixed(1);

      console.log(`\n📊 Progress: ${i + 1}/${data.length} | ✅ ${successCount} | ❌ ${errorCount} | ⏱️  ${elapsed}min elapsed | ~${estMin}min remaining`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log('\n\n🎉 All done!');
  console.log(`📊 Summary:`);
  console.log(`   ✅ Success: ${successCount}`);
  console.log(`   ❌ Failed: ${errorCount}`);
  console.log(`   📋 Total: ${data.length}`);
  console.log(`   ⏱️  Total time: ${totalTime} minutes`);
  console.log(`📁 Files saved to: ${DOWNLOAD_DIR}`);

  await browser.close();
}

// Run
downloadCertificatesManual().catch(console.error);

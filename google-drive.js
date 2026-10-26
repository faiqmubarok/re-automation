import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Initialize Google Drive API
 * @param {string} credentialsPath - Path to credentials.json
 * @returns {Promise<google.auth.OAuth2>} Authorized OAuth2 client
 */
export async function authorize(credentialsPath) {
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Check if we have previously stored a token
  const TOKEN_PATH = path.join(__dirname, 'token.json');
  
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    if (!token.access_token && !token.refresh_token) {
      throw new Error('token.json tidak valid (tidak berisi access_token / refresh_token). Silakan jalankan: npm run setup-drive');
    }
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }
  
  throw new Error('Token not found. Please run setup first to authenticate.');
}

/**
 * Upload file to Google Drive
 * @param {google.auth.OAuth2} auth - Authorized OAuth2 client
 * @param {string} filePath - Local file path to upload
 * @param {string} fileName - Name for the file in Google Drive
 * @param {string} folderId - Google Drive folder ID
 * @returns {Promise<Object>} Upload result with file ID and webViewLink
 */
export async function uploadFile(auth, filePath, fileName, folderId) {
  const drive = google.drive({ version: 'v3', auth });
  
  const fileMetadata = {
    name: fileName,
    parents: [folderId]
  };
  
  const media = {
    mimeType: 'application/pdf',
    body: fs.createReadStream(filePath)
  };
  
  try {
    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink'
    });
    
    return {
      success: true,
      fileId: response.data.id,
      name: response.data.name,
      webViewLink: response.data.webViewLink
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Generate authentication URL and get token
 * This should be run once to set up authentication
 */
export async function setupAuth(credentialsPath) {
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  return { oAuth2Client, authUrl };
}

/**
 * Store token after OAuth callback
 */
export async function storeToken(oAuth2Client, code) {
  let cleanCode = (code || '').trim();
  if (cleanCode.includes('code=')) {
    try {
      const urlObj = new URL(cleanCode.startsWith('http') ? cleanCode : `http://localhost/${cleanCode}`);
      cleanCode = urlObj.searchParams.get('code') || cleanCode;
    } catch (_) {
      const match = cleanCode.match(/[?&]code=([^&]+)/);
      if (match) cleanCode = match[1];
    }
  }
  cleanCode = decodeURIComponent(cleanCode);

  const { tokens } = await oAuth2Client.getToken(cleanCode);
  oAuth2Client.setCredentials(tokens);
  
  const TOKEN_PATH = path.join(__dirname, 'token.json');
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  
  return tokens;
}

// Private Drive -> R2 synchronizer. Never publishes or shares source files.
// Explicitly selected file IDs only; dry-run unless --apply is passed.
// Required for --apply: GOOGLE_DRIVE_ACCESS_TOKEN, CLOUDFLARE_ACCOUNT_ID,
// R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
import { createHash } from "node:crypto";

const apply = process.argv.includes("--apply");
const folderId = process.env.DRIVE_FOLDER_ID;
const selectedIds = new Set((process.env.DRIVE_VIDEO_FILE_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const prefix = "products/approved/";
const videoMime = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]);
const token = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
if (!folderId || !/^[a-zA-Z0-9_-]+$/.test(folderId)) throw new Error("DRIVE_FOLDER_ID required");
if (apply && (!token || !selectedIds.size)) throw new Error("Apply requires Drive token and explicit approved file IDs");
if (apply && !["CLOUDFLARE_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"].every(k => process.env[k])) throw new Error("R2 credentials missing");
if (!token) { console.log("PREFLIGHT ONLY: Drive token not supplied; no files read or transferred."); process.exit(0); }
const drive = async (url) => {
  const res = await fetch(url, {headers:{Authorization:"Bearer "+token}});
  if (!res.ok) throw new Error("Drive API returned "+res.status);
  return res;
};
const files=[];
let pageToken;
do {
  const query = new URLSearchParams({q:`'${folderId}' in parents and trashed = false`,fields:"nextPageToken,files(id,name,mimeType,size,parents)",pageSize:"1000"});
  if (pageToken) query.set("pageToken",pageToken);
  const data = await (await drive("https://www.googleapis.com/drive/v3/files?"+query)).json();
  files.push(...(data.files||[])); pageToken=data.nextPageToken;
} while (pageToken);
const videos=files.filter(f=>videoMime.has(f.mimeType)&&selectedIds.has(f.id));
console.log(JSON.stringify({mode:apply?"apply":"dry-run",folderId,scanned:files.length,approvedVideoCount:videos.length,unapprovedCount:files.length-videos.length},null,2));
if (!apply) process.exit(0);
const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const s3=new S3Client({region:"auto",endpoint:`https://${account}.r2.cloudflarestorage.com`,credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
for (const file of videos) {
  // Stable key, no raw filenames or user-supplied paths; object stays private.
  const suffix=file.mimeType==="video/quicktime"?"mov":file.mimeType==="video/webm"?"webm":file.mimeType==="video/x-matroska"?"mkv":"mp4";
  const key=prefix+createHash("sha256").update(file.id).digest("hex").slice(0,24)+"."+suffix;
  const response=await drive("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(file.id)+"?alt=media");
  if (!response.body) throw new Error("Missing stream for approved file");
  await s3.send(new PutObjectCommand({Bucket:process.env.R2_BUCKET,Key:key,Body:response.body,ContentType:file.mimeType,ContentLength:Number(file.size)}));
  console.log("Uploaded approved video:",key);
}

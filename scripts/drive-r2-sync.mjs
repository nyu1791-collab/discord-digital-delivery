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
if (apply && videos.length !== selectedIds.size) throw new Error("Some approved file IDs are absent or are not videos");
console.log(JSON.stringify({mode:apply?"apply":"dry-run",folderId,scanned:files.length,approvedVideoCount:videos.length,unapprovedCount:files.length-videos.length},null,2));
if (!apply) process.exit(0);
const { S3Client, UploadPartCommand, CreateMultipartUploadCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const s3=new S3Client({region:"auto",endpoint:`https://${account}.r2.cloudflarestorage.com`,credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
for (const file of videos) {
  // Stable key, no raw filenames or user-supplied paths; object stays private.
  const suffix=file.mimeType==="video/quicktime"?"mov":file.mimeType==="video/webm"?"webm":file.mimeType==="video/x-matroska"?"mkv":"mp4";
  const key=prefix+createHash("sha256").update(file.id).digest("hex").slice(0,24)+"."+suffix;
  const size=Number(file.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid video size");
  try {
    await s3.send(new HeadObjectCommand({Bucket:process.env.R2_BUCKET,Key:key}));
    console.log("Already uploaded:",key);
    continue;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== "NotFound") throw error;
  }
  const partSize=32*1024*1024;
  const upload=await s3.send(new CreateMultipartUploadCommand({Bucket:process.env.R2_BUCKET,Key:key,ContentType:file.mimeType}));
  const parts=[];
  try {
    for(let offset=0,part=1;offset<size;offset+=partSize,part++) {
      const end=Math.min(size-1,offset+partSize-1);
      // Request only the required byte range from Drive.
      let response;
      for (let attempt=0;attempt<3;attempt++) {
        response=await fetch("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(file.id)+"?alt=media",{headers:{Authorization:"Bearer "+token,Range:"bytes="+offset+"-"+end}});
        if (response.ok || ![429,500,502,503,504].includes(response.status)) break;
        await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
      }
      if(response.status!==206 && !(response.status===200 && offset===0 && size<=partSize)) throw new Error("Drive range request failed: "+response.status);
      const body=new Uint8Array(await response.arrayBuffer());
      if(body.length!==end-offset+1) throw new Error("Unexpected Drive part length");
      const sent=await s3.send(new UploadPartCommand({Bucket:process.env.R2_BUCKET,Key:key,UploadId:upload.UploadId,PartNumber:part,Body:body}));
      parts.push({ETag:sent.ETag,PartNumber:part});
    }
    await s3.send(new CompleteMultipartUploadCommand({Bucket:process.env.R2_BUCKET,Key:key,UploadId:upload.UploadId,MultipartUpload:{Parts:parts}}));
    console.log("Uploaded approved video:",key);
  } catch(error) {
    await s3.send(new AbortMultipartUploadCommand({Bucket:process.env.R2_BUCKET,Key:key,UploadId:upload.UploadId})).catch(()=>{});
    throw error;
  }
}

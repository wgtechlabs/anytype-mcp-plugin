#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomBytes, scryptSync, createCipheriv, createDecipheriv} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import assert from 'node:assert/strict';

process.umask(0o077);
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const magic = Buffer.from('ANYBAK01');
const derive = (password, salt) => scryptSync(password, salt, 32, {N:32768,r:8,p:1,maxmem:64*1024*1024});
function stopped(root) {
  const pidFile=path.join(root,'anytype.pid');
  if (!fs.existsSync(pidFile)) return;
  const pid=Number(fs.readFileSync(pidFile,'utf8'));
  if (!Number.isSafeInteger(pid)||pid<2) throw Error('Invalid PID file; verify the runtime is stopped.');
  try {process.kill(pid,0);} catch(error) {if(error.code==='ESRCH') return; throw error;}
  throw Error('Stop Anytype before taking a consistent backup.');
}
function noLinks(dir) {
  for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
    const entry=path.join(dir,item.name);
    if (item.isSymbolicLink()||(!item.isFile()&&!item.isDirectory())) throw Error('Backups accept regular files and directories only.');
    if(item.isDirectory()) noLinks(entry);
  }
}
export async function createBackup(root, output, password) {
  root=path.resolve(root); output=path.resolve(output);
  if(output===root||output.startsWith(`${root}${path.sep}`)) throw Error('Write backups outside the runtime directory.');
  stopped(root);
  const names=['home','data','secrets','gateway.env'].filter(name=>fs.existsSync(path.join(root,name)));
  if(!names.includes('data')||!names.includes('home')) throw Error('Runtime home and data directories are required.');
  for (const name of names) {const item=path.join(root,name);if(fs.lstatSync(item).isSymbolicLink()) throw Error('Symbolic links are unsupported.');if(fs.statSync(item).isDirectory())noLinks(item);}
  const salt=randomBytes(16),nonce=randomBytes(12),header=Buffer.concat([magic,salt,nonce]);
  const cipher=createCipheriv('aes-256-gcm',derive(password,salt),nonce);cipher.setAAD(header);
  const temp=`${output}.${randomBytes(8).toString('hex')}.tmp`;
  const tar=spawn('tar',['-czf','-','-C',root,...names],{stdio:['ignore','pipe','pipe']});
  const finished=new Promise((resolve,reject)=>{tar.on('error',reject);tar.on('close',code=>code===0?resolve():reject(Error('Snapshot archive creation failed.')));});
  tar.stderr.resume();
  try {
    fs.writeFileSync(temp,header,{flag:'wx',mode:0o600});
    await Promise.all([pipeline(tar.stdout,cipher,fs.createWriteStream(temp,{flags:'a'})),finished]);
    stopped(root);
    fs.appendFileSync(temp,cipher.getAuthTag());
    // link refuses replacement; an existing backup can never be overwritten.
    fs.linkSync(temp,output);fs.unlinkSync(temp);
  } catch(error) {tar.kill();fs.rmSync(temp,{force:true});throw error;}
}
export async function restoreBackup(input,destination,password) {
  input=path.resolve(input);destination=path.resolve(destination);
  if(fs.existsSync(destination)&&(fs.lstatSync(destination).isSymbolicLink()||!fs.statSync(destination).isDirectory()||fs.readdirSync(destination).length)) throw Error('Restore destination must be absent or an empty directory.');
  const size=fs.statSync(input).size;
  if(size<52) throw Error('Invalid encrypted backup.');
  const fd=fs.openSync(input,'r'),header=Buffer.alloc(36),tag=Buffer.alloc(16);
  try {fs.readSync(fd,header,0,36,0);fs.readSync(fd,tag,0,16,size-16);}finally{fs.closeSync(fd);}
  if(!header.subarray(0,8).equals(magic)) throw Error('Unsupported backup format.');
  const temp=fs.mkdtempSync(path.join(path.dirname(destination),'.anytype-restore-'));
  try {
    const archive=path.join(temp,'snapshot.tar.gz');
    const decipher=createDecipheriv('aes-256-gcm',derive(password,header.subarray(8,24)),header.subarray(24));
    decipher.setAAD(header);decipher.setAuthTag(tag);
    // Authentication must complete before any archive content is extracted.
    await pipeline(fs.createReadStream(input,{start:36,end:size-17}),decipher,fs.createWriteStream(archive,{flags:'wx',mode:0o600}));
    const options={encoding:'utf8',maxBuffer:16*1024*1024};
    const names=execFileSync('tar',['-tzf',archive],options).trim().split('\n');
    if(names.some(name=>path.posix.isAbsolute(name)||name.split('/').some(part=>part==='..')||!['home','data','secrets','gateway.env'].includes(name.split('/')[0]))) throw Error('Unsafe archive path.');
    const entries=execFileSync('tar',['-tvzf',archive],options).trim().split('\n');
    if(entries.some(entry=>!['d','-'].includes(entry[0]))) throw Error('Archive contains a link or special file.');
    const extracted=path.join(temp,'restored');fs.mkdirSync(extracted,{mode:0o700});
    execFileSync('tar',['-xzf',archive,'-C',extracted,'--no-same-owner'],{stdio:'ignore'});
    fs.renameSync(extracted,destination);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
async function selfTest() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anytype-backup-check-'));
  try {
    const source=path.join(root,'source');fs.mkdirSync(`${source}/home`,{recursive:true});fs.mkdirSync(`${source}/data`);
    fs.writeFileSync(`${source}/data/proof.txt`,'restored exactly');
    const file=path.join(root,'backup.enc'),password='test-only-passphrase-with-enough-entropy';
    await createBackup(source,file,password);
    await assert.rejects(()=>restoreBackup(file,path.join(root,'bad'),'incorrect-password'));
    assert.equal(fs.existsSync(path.join(root,'bad')),false);
    await restoreBackup(file,path.join(root,'restored'),password);
    assert.equal(fs.readFileSync(path.join(root,'restored/data/proof.txt'),'utf8'),'restored exactly');
    await assert.rejects(()=>restoreBackup(file,path.join(root,'restored'),password));
    const contents=fs.readFileSync(file);contents[40]^=1;fs.writeFileSync(path.join(root,'tampered.enc'),contents);
    await assert.rejects(()=>restoreBackup(path.join(root,'tampered.enc'),path.join(root,'tampered'),password));
    fs.writeFileSync(`${source}/anytype.pid`,String(process.pid));
    await assert.rejects(()=>createBackup(source,path.join(root,'running.enc'),password));
    console.log('Backup checks passed: round trip, wrong password, tampering, nonempty destination, running instance.');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const [command,file,destination]=process.argv.slice(2);
    if(command==='--self-test') await selfTest();
    else {
      const password=process.env.BACKUP_PASSPHRASE;
      if(!password||password.length<16) throw Error('Set BACKUP_PASSPHRASE to a strong secret of at least 16 characters.');
      if(command==='create'&&file) await createBackup(process.env.ANYTYPE_RUNTIME_DIR||path.join(project,'.local'),file,password);
      else if(command==='restore'&&file&&destination) await restoreBackup(file,destination,password);
      else throw Error('Usage: node scripts/backup.mjs create FILE | restore FILE EMPTY_DIRECTORY | --self-test');
      console.log(command==='create'?'Encrypted backup written.':'Authenticated backup restored into the empty destination.');
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}

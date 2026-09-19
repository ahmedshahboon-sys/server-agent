import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { MaintenanceService } from '../../src/maintenance/maintenance-service.js';
import { ConflictError } from '../../src/core/errors.js';
import { tempDir } from '../helpers.js';

test('maintenance mode and low disk fail closed before mutation', async () => {
  const temp=await tempDir('server-agent-maintenance-');
  const dbPath=path.join(temp.path,'state.sqlite');
  const db=new SqliteDatabase(dbPath);
  try{
    const maintenance=new MaintenanceService(db,{dataDir:temp.path,dbPath,maintenanceMode:true,operationalRetentionDays:30,jobLogRetentionDays:14,minFreeDiskBytes:1,stateDbWarningBytes:536870912});
    assert.throws(()=>maintenance.assertMutationAllowed(),ConflictError);
    const lowDisk=new MaintenanceService(db,{dataDir:temp.path,dbPath,maintenanceMode:false,operationalRetentionDays:30,jobLogRetentionDays:14,minFreeDiskBytes:Number.MAX_SAFE_INTEGER,stateDbWarningBytes:536870912});
    assert.throws(()=>lowDisk.assertMutationAllowed(),ConflictError);
  }finally{db.close();await temp.cleanup();}
});

test('startup maintenance prunes bounded stale telemetry and job logs without deleting durable job records', async () => {
  const temp=await tempDir('server-agent-retention-');
  const dbPath=path.join(temp.path,'state.sqlite');
  const db=new SqliteDatabase(dbPath);
  try{
    const old='2020-01-01T00:00:00.000Z';
    db.raw.prepare('INSERT INTO idempotency_keys(scope,idempotency_key,fingerprint,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('test','old','fingerprint','COMPLETED','{}',old,old);
    const jobDir=path.join(temp.path,'jobs','job-old');
    await mkdir(jobDir,{recursive:true});
    const stdoutPath=path.join(jobDir,'stdout.log'),stderrPath=path.join(jobDir,'stderr.log');
    await writeFile(stdoutPath,'old output');await writeFile(stderrPath,'old error');
    db.raw.exec("PRAGMA foreign_keys=OFF");
    db.raw.prepare('INSERT INTO jobs(job_id,task_id,project_id,command_id,pid,started_at,finished_at,status,exit_code,stdout_path,stderr_path,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('job-old',null,'archived-project','test',null,old,old,'COMPLETED',0,stdoutPath,stderrPath,null);
    db.raw.exec("PRAGMA foreign_keys=ON");
    const maintenance=new MaintenanceService(db,{dataDir:temp.path,dbPath,maintenanceMode:false,operationalRetentionDays:30,jobLogRetentionDays:14,minFreeDiskBytes:1,stateDbWarningBytes:536870912});
    const report=await maintenance.runStartupMaintenance(new Date('2026-09-19T00:00:00.000Z'));
    assert.equal(report.idempotencyKeysDeleted,1);
    assert.equal(report.jobLogFilesDeleted,2);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM jobs WHERE job_id=?').get('job-old')?.['n'],1);
    const readiness=maintenance.readiness();
    assert.equal(readiness['ready'],true);
    const metrics=maintenance.metrics();
    assert.equal(typeof metrics.freeDiskBytes,'number');
  }finally{db.close();await temp.cleanup();}
});

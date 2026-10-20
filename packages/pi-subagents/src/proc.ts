import { readdirSync, readFileSync } from 'node:fs';

export interface ProcStat {
  state: string;
  pgrp: number;
  session: number;
  startTicks: number;
}

export function procStat(pid: number): ProcStat | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0], pgrp: Number(rest[2]), session: Number(rest[3]), startTicks: Number(rest[19]) };
  } catch {
    return undefined;
  }
}

export function currentBootId(): string | undefined {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return undefined; }
}

/** Liveness of a recorded process identity: boot, pid, state and start ticks. */
export function identityAlive(pid: number | undefined, startTicks: number | undefined, bootId: string | undefined): boolean {
  if (!pid) return false;
  if (bootId && currentBootId() !== bootId) return false;
  const stat = procStat(pid);
  if (!stat || stat.state === 'Z') return false;
  if (startTicks !== undefined && stat.startTicks !== startTicks) return false;
  return true;
}

export interface GroupMember { pid: number; startTicks: number }

export function groupMembers(sessionId: number): GroupMember[] {
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return []; }
  const members: GroupMember[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = procStat(pid);
    if (!stat || stat.session !== sessionId) continue;
    members.push({ pid, startTicks: stat.startTicks });
  }
  return members;
}

/** A worker group is ours only while a member started at or after the worker. */
export function groupAlive(workerPid: number | undefined, workerStartTicks: number | undefined): boolean {
  if (!workerPid) return false;
  const members = groupMembers(workerPid);
  if (!members.length) return false;
  if (workerStartTicks === undefined) return true;
  return members.some(member => member.startTicks >= workerStartTicks);
}

export function killGroup(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(-pid, 'SIGKILL'); return true; } catch { return false; }
}

export function signal(pid: number | undefined, signalName: NodeJS.Signals): boolean {
  if (!pid) return false;
  try { process.kill(pid, signalName); return true; } catch { return false; }
}

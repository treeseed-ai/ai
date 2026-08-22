#!/usr/bin/env node
import{randomBytes}from'node:crypto';import{hashApiKey}from'./auth.js';
const id=process.argv[2]??randomBytes(6).toString('hex');const scopes=(process.argv[3]??'*').split(',').filter(Boolean);const secret=randomBytes(32).toString('base64url');process.stdout.write(JSON.stringify({credential:`ak_${id}_${secret}`,record:{id,hash:hashApiKey(secret),scopes,revoked:false}},null,2)+'\n');

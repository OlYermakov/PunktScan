import test from 'node:test';import assert from 'node:assert/strict';import {validQuad,fullQuad,rectify,findTable,originalRegion} from '../src/imaging.js';
test('crossed or degenerate crop frames are rejected',()=>{assert.ok(validQuad(fullQuad()));assert.equal(validQuad([{x:0,y:0},{x:1,y:1},{x:1,y:0},{x:0,y:1}]),false);assert.equal(validQuad([{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:0,y:0}]),false);});
test('blank images do not produce fake table boundaries',()=>{assert.equal(findTable(new Uint8ClampedArray(100*100*4).fill(255),100,100),null);});
test('rectification remains bounded and preserves white pixels',()=>{const p=new Uint8ClampedArray(100*80*4).fill(255),r=rectify(p,100,80,fullQuad(),false);assert.ok(r.width*r.height<=4000000);assert.ok(r.data.every(v=>v===255));});
test('review crop maps to the original image and includes the source row',()=>{const r=originalRegion(fullQuad(),{y0:40,y1:60},100,100,100,100);assert.equal(r.x,0);assert.equal(r.w,100);assert.ok(r.y<40);assert.ok(r.y+r.h>60);});
test('a slightly skewed convex frame is accepted',()=>{const q=[{x:.1,y:.1},{x:.9,y:.12},{x:.88,y:.9},{x:.12,y:.88}];assert.ok(validQuad(q));});

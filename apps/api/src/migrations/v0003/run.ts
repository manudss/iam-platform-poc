import type {INestApplication}from'@nestjs/common';
import{WorkflowStore}from'../../workflows/store.js';
/** Operational meta storage only. No workflow activation, provider effects or business-row rewrite. */
export function nativeConnectorStorageMigration(app:INestApplication){return{id:'0003',run:async()=>{await app.get(WorkflowStore,{strict:false}).preparePieceStorage();},verify:async()=>{await app.get(WorkflowStore,{strict:false}).verifyPieceStorage();}};}

// После восстановления старого snapshot невозможно знать, какие задания уже звонили.
// Применять только к восстановленной БД при остановленном model service.
import {existsSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {openJobStore} from '../lib/job-store.mjs';
const path=process.argv[2];if(!path||!isAbsolute(path)||!existsSync(path))throw new Error('Укажите абсолютный путь восстановленной БД');
const store=openJobStore({path});let count=0;
try{store.recover(Date.now());for(const job of store.runnable()){store.updateAttempt(job.id,{state:'unknown',reason:'Восстановлена резервная копия: требуется проверка и новое задание'});count++;}console.log(`Восстановление подготовлено. Автозапуск отключён для ${count} заданий.`);}finally{store.close();}

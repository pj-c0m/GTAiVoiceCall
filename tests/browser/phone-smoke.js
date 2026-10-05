// Запуск через playwright-cli run-code --filename; только localhost без key/bridge.
async page => {
 const origin=new URL(page.url()).origin;
 if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Smoke допускает только localhost');
 const config=await page.request.get(origin+'/api/config').then(r=>r.json());
 if(config.hasKey||config.pbx?.configured)throw Error('Smoke требует отсутствия key и bridge');
 await page.goto(origin+'/?profile=example-call');
 const topic='Browser smoke '+Date.now();
 await page.getByRole('textbox',{name:'Номер',exact:true}).fill('test:sim1');
 await page.getByRole('textbox',{name:'Имя',exact:true}).fill('Демо-контакт');
 await page.getByRole('textbox',{name:'Тема разговора',exact:true}).fill(topic);
 await page.getByRole('textbox',{name:'Цель',exact:true}).fill('Синтетическая проверка без звонка');
 await page.getByRole('radio',{name:'Выбрать время',exact:true}).check();
 await page.getByRole('textbox',{name:'Дата и время',exact:true}).fill(new Date(Date.now()+86400000).toISOString().slice(0,16));
 const zone=page.getByRole('combobox',{name:'Часовой пояс',exact:true});await zone.fill('Mars/Unknown');
 await page.getByRole('button',{name:'Проверить звонок',exact:true}).click();
 await page.locator('#job-error-timeZone').waitFor();
 if(await zone.getAttribute('aria-invalid')!=='true'||!(await zone.evaluate(n=>n===document.activeElement)))throw Error('Ошибка не привязана к полю');
 await zone.fill('Europe/Moscow');await page.getByRole('button',{name:'Проверить звонок',exact:true}).click();
 await page.getByRole('button',{name:'Запланировать звонок',exact:true}).waitFor();
 let lost=false;const keys=[];
 await page.route('**/api/jobs',async route=>{
  if(route.request().method()!=='POST'){await route.continue();return;}
  keys.push(route.request().headers()['idempotency-key']);
  if(!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();
 });
 await page.getByRole('button',{name:'Запланировать звонок',exact:true}).click();
 await page.getByRole('button',{name:'Повторить отправку',exact:true}).waitFor();
 await page.getByRole('button',{name:'Повторить отправку',exact:true}).click();
 await page.getByText('Задание сохранено. Эту страницу можно закрыть.',{exact:true}).waitFor();
 if(keys.length!==2||keys[0]!==keys[1])throw Error('Retry изменил idempotency key');
 const data=await page.request.get(origin+'/api/jobs').then(r=>r.json());
 if(data.jobs.filter(j=>j.topic===topic).length!==1)throw Error('Создан дубль');
 await page.getByRole('button',{name:'Отменить звонок',exact:true}).click();
 await page.unroute('**/api/jobs');await page.reload();
 const row=page.getByRole('button',{name:new RegExp(topic)});await row.waitFor();
 if(!(await row.textContent()).includes('Отменён'))throw Error('Отмена не пережила reload');
 await row.focus();await page.waitForTimeout(4200);if(!(await row.evaluate(n=>n===document.activeElement)))throw Error('Polling потерял focus');
 await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');
}

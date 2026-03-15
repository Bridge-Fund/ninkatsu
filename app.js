// ══════════════════════════════════════════════════════════════
//  妊活ノート – App Logic
// ══════════════════════════════════════════════════════════════

// ── ストレージ ───────────────────────────────────────────────
const DB = {
  get(k,d=null){try{const v=localStorage.getItem(k);return v!=null?JSON.parse(v):d}catch{return d}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){console.warn(e)}},
  getCycles(){return this.get('cycles',[])},
  getMeds(){return this.get('medications',[])},
  getDoctors(){return this.get('doctors',[])},
  getMemo(dateStr){return this.get('memo_'+dateStr,null)},
  setMemo(dateStr,v){this.set('memo_'+dateStr,v)},
  getGcalEvents(){return this.get('gcal_events',[])},
  setGcalEvents(v){this.set('gcal_events',v)},
  getTasksDone(dateStr){return this.get('tasks_done_'+dateStr,{})},
  setTasksDone(dateStr,v){this.set('tasks_done_'+dateStr,v)},
};

// ── 日付ユーティリティ ────────────────────────────────────────
const D = {
  today(){return this.ymd(new Date())},
  ymd(dt){return`${dt.getFullYear()}-${String(dt.getMonth()+1).padLeft(2,'0')}-${String(dt.getDate()).padLeft(2,'0')}`},
  parse(s){const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d)},
  addDays(dt,n){const r=new Date(dt);r.setDate(r.getDate()+n);return r},
  diffDays(a,b){return Math.round((this.parse(a)-this.parse(b))/(864e5))},
  fmt(dateStr){const dt=this.parse(dateStr);const days=['日','月','火','水','木','金','土'];return`${dt.getMonth()+1}月${dt.getDate()}日（${days[dt.getDay()]}）`},
  fmtShort(dateStr){const dt=this.parse(dateStr);return`${dt.getMonth()+1}/${dt.getDate()}`},
};
String.prototype.padLeft=function(n,c){return this.padStart(n,c)};

// ── 予測エンジン ──────────────────────────────────────────────
const Predict = {
  run(){
    const cycles = DB.getCycles();
    const today = D.today();
    const DEFAULT_LEN = 28;
    const LUTEAL = 14;

    // 平均周期
    const lens = cycles.filter(c=>c.len&&c.len>15).map(c=>c.len).slice(0,4);
    const avg = lens.length ? Math.round(lens.reduce((a,b)=>a+b)/lens.length) : DEFAULT_LEN;

    // 最新の生理開始日
    const lastStart = cycles.length ? cycles[0].start : today;

    // 今日が何日目
    const cycleDay = Math.max(1, D.diffDays(today, lastStart) + 1);

    // 排卵予測日
    const ovulDay = avg - LUTEAL; // 周期の何日目
    const ovulDate = D.ymd(D.addDays(D.parse(lastStart), ovulDay - 1));

    // 次の生理予定日
    const nextPeriod = D.ymd(D.addDays(D.parse(lastStart), avg));

    // タイミング推奨日（排卵2日前〜1日後）
    const timingDays = [-2,-1,0,1]
      .map(n => D.ymd(D.addDays(D.parse(ovulDate), n)))
      .filter(d => d >= today);

    // 生理期間（直近5日間）
    const periodDays = [];
    for(let i=0;i<5;i++) periodDays.push(D.ymd(D.addDays(D.parse(lastStart),i)));

    return {avg, cycleDay, lastStart, ovulDate, nextPeriod, timingDays, periodDays, cycles};
  },

  // 指定日のイベント（ローカル生成）
  eventsForDay(dateStr){
    const p = this.run();
    const meds = DB.getMeds().filter(m=>m.active!==false);
    const events = [];

    // ── 今周期の生理期間（lastStart〜+4日）
    if(p.periodDays.includes(dateStr))
      events.push({type:'period',title:'生理期間',emoji:'🔴'});

    // ── 次周期の生理予測期間（nextPeriod〜+4日）
    for(let i=0;i<5;i++){
      const d = D.ymd(D.addDays(D.parse(p.nextPeriod),i));
      if(d===dateStr) events.push({type:'period',title:'生理予測',emoji:'🔴'});
    }

    // ── 今周期の排卵予測日
    if(dateStr===p.ovulDate)
      events.push({type:'ovulation',title:'排卵予測日',emoji:'⭐'});

    // ── 次周期の排卵予測日（nextPeriod + avg-14 日目）
    const nextOvul = D.ymd(D.addDays(D.parse(p.nextPeriod), p.avg-14-1));
    if(dateStr===nextOvul)
      events.push({type:'ovulation',title:'排卵予測日',emoji:'⭐'});

    // ── 今周期のタイミング推奨
    if(p.timingDays.includes(dateStr))
      events.push({type:'timing',title:'タイミング推奨',emoji:'💜'});

    // ── 次周期のタイミング推奨（nextOvul の前後）
    const nextTimings = [-2,-1,0,1].map(n=>D.ymd(D.addDays(D.parse(nextOvul),n)));
    if(nextTimings.includes(dateStr))
      events.push({type:'timing',title:'タイミング推奨',emoji:'💜'});

    // 服薬・注射（個別日配列 or 旧startDay/endDay 両対応）
    const cycleDay = D.diffDays(dateStr, p.lastStart) + 1;
    for(const med of meds){
      let medDays = [];
      if(med.days && Array.isArray(med.days)){
        medDays = med.days;
      } else {
        const start = med.startDay||1, end = med.endDay||7;
        for(let i=start;i<=end;i++) medDays.push(i);
      }
      if(medDays.includes(cycleDay)){
        events.push({
          type: med.type==='injection'?'injection':'medication',
          title: med.name,
          subtitle: med.dosage||'',
          emoji: {pill:'💊',injection:'💉',patch:'🩹',other:'🏥'}[med.type]||'💊',
          medId: med.id,
          time: med.time||'',
        });
      }
    }

    // Googleカレンダーイベント
    const gcalEvents = DB.getGcalEvents();
    for(const e of gcalEvents){
      if(e.date===dateStr)
        events.push({type:'google',title:e.title,emoji:'📅',googleId:e.id});
    }

    // 担当医の出勤日（曜日マッチング）
    const doctors = DB.getDoctors();
    const dtObj = D.parse(dateStr);
    const wd = dtObj.getDay();
    const wdDoc = wd===0 ? 7 : wd;
    for(const doc of doctors){
      const slots = (doc.slots||[]).filter(s=>Number(s.wd)===wdDoc);
      for(const slot of slots){
        events.push({
          type:'doctor',
          title:doc.name,
          subtitle:`診察 ${slot.start}〜${slot.end}`,
          emoji:'👩‍⚕️',
        });
      }
    }

    return events;
  },
};

// ── App 状態管理 ─────────────────────────────────────────────
const App = {
  gcalSignedIn: false,
  gcalClientId: '933510200109-uo60ubqugf1lg8dp6ii2fg69df218ptd.apps.googleusercontent.com', // Google Cloud ConsoleのクライアントID（README参照）

  init(){
    // Service Worker登録
    if('serviceWorker' in navigator)
      navigator.serviceWorker.register('./sw.js').catch(()=>{});

    this.refreshAll();

    // 日付変更チェック（1分ごと）
    setInterval(()=>this.refreshAll(), 60000);
  },

  refreshAll(){
    HomeUI.render();
    if(document.getElementById('scr-calendar').classList.contains('active'))
      Cal.render();
    if(document.getElementById('scr-predict').classList.contains('active'))
      PredUI.render();
    if(document.getElementById('scr-doctor').classList.contains('active'))
      DoctorUI.render();
    if(document.getElementById('scr-memo').classList.contains('active'))
      Memo.render();
  },

  recordPeriod(){
    const dateStr = document.getElementById('period-date-input').value;
    if(!dateStr) return;
    const cycles = DB.getCycles();
    let len = null;
    if(cycles.length) len = D.diffDays(dateStr, cycles[0].start);
    cycles.unshift({start:dateStr, len});
    DB.set('cycles', cycles.slice(0,24));
    UI.close('ov-period');
    this.refreshAll();
    // Googleカレンダーに書き込む
    if(this.gcalSignedIn) GCal.writePredictions();
    toast('生理開始日を記録しました 🌸');
  },

  gcalSignOut(){
    this.gcalSignedIn = false;
    DB.setGcalEvents([]);
    HomeUI.render();
    toast('Google連携を解除しました');
  },
};

// ── ナビゲーション ─────────────────────────────────────────────
const Nav = {
  go(tab, btn){
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
    document.getElementById('scr-'+tab).classList.add('active');
    btn.classList.add('active');

    // 各画面のレンダリング
    if(tab==='calendar'){
      // ④ Google予定をカレンダー表示前に最新取得してから描画
      if(App.gcalSignedIn){
        GCal.fetchPersonalEvents().then(()=>Cal.render());
      } else {
        Cal.render();
      }
    }
    if(tab==='predict') PredUI.render();
    if(tab==='doctor') DoctorUI.render();
    if(tab==='memo') Memo.render();
  },
};

// ── ホーム画面 ────────────────────────────────────────────────
const HomeUI = {
  render(){
    const p = Predict.run();
    const today = D.today();
    const days = ['日','月','火','水','木','金','土'];
    const dt = new Date();
    document.getElementById('home-date').textContent =
      `${dt.getMonth()+1}月${dt.getDate()}日 ${days[dt.getDay()]}曜日 · 周期${p.cycleDay}日目`;

    // カウントダウン
    const toOvul = Math.max(0, D.diffDays(p.ovulDate, today));
    const toPeriod = Math.max(0, D.diffDays(p.nextPeriod, today));
    document.getElementById('cnt-ovulation').textContent = toOvul;
    document.getElementById('cnt-period').textContent = toPeriod;

    // Google連携バナー
    const banner = document.getElementById('gcal-banner-home');
    banner.classList.toggle('hidden', !App.gcalSignedIn);

    // 今日のタスク
    const tasks = document.getElementById('today-tasks');
    const events = Predict.eventsForDay(today)
      .filter(e=>e.type==='medication'||e.type==='injection');
    const doneMap = DB.getTasksDone(today);

    if(events.length===0){
      tasks.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);font-size:13px">今日の服薬・注射はありません</div>`;
      return;
    }

    tasks.innerHTML = events.map((ev,i)=>{
      const key = ev.medId+'_'+i;
      const done = doneMap[key]||false;
      const bgColor = ev.type==='injection'?'var(--blue-light)':'var(--purple-light)';
      return `<div class="task-item" style="${done?'opacity:.5':''}">
        <div class="task-icon" style="background:${bgColor}">${ev.emoji}</div>
        <div class="task-info">
          <div class="task-name" style="${done?'text-decoration:line-through':''}">${ev.title}</div>
          <div class="task-sub">${ev.subtitle||''}${ev.time?' · '+ev.time:''}</div>
        </div>
        <div class="task-check ${done?'done':''}" onclick="HomeUI.toggleTask('${key}',this)">${done?'✓':''}</div>
      </div>`;
    }).join('');
  },

  toggleTask(key, el){
    const today = D.today();
    const doneMap = DB.getTasksDone(today);
    doneMap[key] = !doneMap[key];
    DB.setTasksDone(today, doneMap);
    HomeUI.render();
  },
};

// ── カレンダー ─────────────────────────────────────────────────
const Cal = {
  year: new Date().getFullYear(),
  month: new Date().getMonth(),
  selected: D.today(),

  init(){
    document.getElementById('cal-prev').onclick = ()=>{ this.prevMonth(); };
    document.getElementById('cal-next').onclick = ()=>{ this.nextMonth(); };
    this.render();
  },

  prevMonth(){ if(this.month===0){this.month=11;this.year--;}else this.month--; this.render(); },
  nextMonth(){ if(this.month===11){this.month=0;this.year++;}else this.month++; this.render(); },

  render(){
    const y=this.year, m=this.month;
    const months=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    document.getElementById('cal-month-label').textContent = `${y}年 ${months[m]}`;

    const firstDay = new Date(y,m,1).getDay();
    const daysInMonth = new Date(y,m+1,0).getDate();
    const today = D.today();
    const p = Predict.run();

    // 曜日ヘッダーを同じグリッドに含める（ズレ防止）
    const dows = ['日','月','火','水','木','金','土'];
    let html = dows.map((d,i)=>`<div class="cal-dow" style="${i===0?'color:#E86B8A':i===6?'color:#4A90D9':''}">${d}</div>`).join('');

    // 空白
    for(let i=0;i<firstDay;i++) html+=`<div class="cal-day empty"></div>`;

    for(let d=1;d<=daysInMonth;d++){
      const dateStr = `${y}-${String(m+1).padLeft(2,'0')}-${String(d).padLeft(2,'0')}`;
      const events = Predict.eventsForDay(dateStr);
      const isToday = dateStr===today;
      const isSel = dateStr===this.selected;
      const hasPeriod = events.some(e=>e.type==='period');
      const hasOvul = events.some(e=>e.type==='ovulation');
      const hasTiming = events.some(e=>e.type==='timing');

      let cls = 'cal-day';
      if(hasPeriod && !isSel) cls += ' period-day';
      if(hasOvul && !isSel) cls += ' ovulation-day';
      if(hasTiming && !isSel && !hasOvul) cls += ' timing-day';
      if(isToday && !isSel) cls += ' today';
      if(isSel) cls += ' selected';

      const dots = events.slice(0,4).map(e=>{
        const c = {period:'var(--pink)',ovulation:'var(--purple)',timing:'#7B5EA7',
                   medication:'#7C5CBF',injection:'var(--blue)',google:'var(--green)',doctor:'var(--amber)'}[e.type]||'var(--text3)';
        return `<div class="dot" style="background:${c}"></div>`;
      }).join('');

      html+=`<div class="${cls}" onclick="Cal.select('${dateStr}')">
        <div class="day-num">${d}</div>
        <div class="day-dots">${dots}</div>
      </div>`;
    }

    document.getElementById('cal-grid').innerHTML = html;
    this.renderEvents();
  },

  select(dateStr){
    this.selected = dateStr;
    this.render();
  },

  renderEvents(){
    const events = Predict.eventsForDay(this.selected);
    const container = document.getElementById('cal-events');
    if(events.length===0){
      container.innerHTML = `<div style="text-align:center;padding:16px;color:var(--text3);font-size:13px">${D.fmt(this.selected)}の予定はありません</div>`;
      return;
    }
    container.innerHTML = `<div style="font-size:13px;font-weight:500;margin-bottom:8px">${D.fmt(this.selected)}</div>`+
      events.map(e=>`<div class="event-item ${e.type}">
        <div class="event-emoji">${e.emoji}</div>
        <div class="event-text">
          <div class="ev-title">${e.title}</div>
          ${e.subtitle?`<div class="ev-sub">${e.subtitle}</div>`:''}
        </div>
      </div>`).join('');
  },
};

// ── 予測画面 ──────────────────────────────────────────────────
const PredUI = {
  render(){
    const p = Predict.run();
    const today = D.today();

    // 周期バー
    const progress = Math.min(100, Math.round((p.cycleDay/p.avg)*100));
    const ovulPct = Math.min(96, Math.round(((p.avg-14)/p.avg)*100));
    document.getElementById('pred-fill').style.width = progress+'%';
    document.getElementById('pred-marker').style.left = ovulPct+'%';
    document.getElementById('pred-cycle-label').textContent =
      `周期${p.cycleDay}日目 · 平均${p.avg}日周期`;

    // 生理予定日
    const toPeriod = D.diffDays(p.nextPeriod, today);
    document.getElementById('pred-period-date').textContent = D.fmt(p.nextPeriod);
    document.getElementById('pred-period-sub').textContent = `あと${toPeriod}日`;

    // 排卵予測日
    const toOvul = D.diffDays(p.ovulDate, today);
    document.getElementById('pred-ovul-date').textContent = D.fmt(p.ovulDate);
    document.getElementById('pred-ovul-sub').textContent = `あと${toOvul}日 · 周期${p.avg-14}日目`;

    // タイミング推奨日
    const chipsEl = document.getElementById('timing-chips');
    if(p.timingDays.length){
      chipsEl.innerHTML = p.timingDays.map(d=>{
        const isBest = d===p.ovulDate;
        return`<div class="timing-chip${isBest?' best':''}">${D.fmtShort(d)}${isBest?' ★最良':''}</div>`;
      }).join('');
    } else {
      chipsEl.innerHTML = `<div class="text-sm">今周期の推奨日は過ぎました</div>`;
    }

    // 周期履歴
    const histEl = document.getElementById('cycle-history');
    if(p.cycles.length===0){
      histEl.innerHTML = `<div class="text-sm">まだ記録がありません</div>`;
      return;
    }
    histEl.innerHTML = p.cycles.slice(0,8).map(c=>`
      <div class="hist-row">
        <div class="hist-date">${D.fmt(c.start)}</div>
        ${c.len?`<div class="hist-badge">${c.len}日周期</div>`:''}
      </div>`).join('');
  },
};

// ── 担当医UI ──────────────────────────────────────────────────
const DoctorUI = {
  render(){
    const doctors = DB.getDoctors();
    const el = document.getElementById('doctor-list');
    const wds = ['','月','火','水','木','金','土','日'];

    if(doctors.length===0){
      el.innerHTML = `<div class="empty">
        <div class="em-icon">👩‍⚕️</div>
        <h3>担当医がまだいません</h3>
        <p>右上の＋から追加してください</p>
      </div>`;
      return;
    }

    el.innerHTML = doctors.map((doc,i)=>{
      // スロットを曜日でグループ化
      const byWd = {};
      (doc.slots||[]).forEach(s=>{ (byWd[s.wd]||(byWd[s.wd]=[])).push(s); });
      const slotHtml = Object.keys(byWd).sort().map(wd=>`
        <div class="slot-day">
          <div class="slot-wd">${wds[wd]}</div>
          <div class="slot-times">
            ${byWd[wd].map(s=>`<div class="slot-pill">${s.start}〜${s.end}</div>`).join('')}
          </div>
        </div>`).join('');
      return`<div class="doctor-card">
        <div class="doctor-header">
          <div class="doctor-avatar">👩‍⚕️</div>
          <div style="flex:1">
            <div class="doctor-name">${doc.name}</div>
            <div class="doctor-spec">${doc.spec||''}</div>
          </div>
          <button class="topbar-btn" style="font-size:16px" onclick="UI.openDoctorSheet(${i})">✏️</button>
        </div>
        <div class="slot-section">${slotHtml||'<div class="text-sm">診察時間帯未登録</div>'}</div>
      </div>`;
    }).join('');
  },
};

// ── 体調メモ ──────────────────────────────────────────────────
const Memo = {
  date: D.today(),
  moodScore: null,

  render(){
    const memo = DB.getMemo(this.date);
    this.moodScore = memo?.mood||null;

    // 日付表示
    document.getElementById('memo-date-disp').textContent = D.fmt(this.date);

    // 周期日
    const p = Predict.run();
    const day = Math.max(1, D.diffDays(this.date, p.lastStart)+1);
    document.getElementById('memo-cycle-badge').textContent = `周期${day}日目`;

    // 気分
    document.querySelectorAll('.mood-btn').forEach(b=>{
      b.classList.toggle('sel', Number(b.dataset.score)===this.moodScore);
    });

    // 体温・メモ
    document.getElementById('temp-input').value = memo?.temp||'';
    document.getElementById('note-input').value = memo?.note||'';
  },

  setMood(score){
    this.moodScore = this.moodScore===score ? null : score;
    document.querySelectorAll('.mood-btn').forEach(b=>{
      b.classList.toggle('sel', Number(b.dataset.score)===this.moodScore);
    });
  },

  save(){
    const temp = parseFloat(document.getElementById('temp-input').value)||null;
    const note = document.getElementById('note-input').value.trim()||null;
    DB.setMemo(this.date, {mood:this.moodScore, temp, note, date:this.date});
    toast('保存しました ✓');
  },

  prevDay(){
    this.date = D.ymd(D.addDays(D.parse(this.date),-1));
    this.render();
  },
  nextDay(){
    const next = D.ymd(D.addDays(D.parse(this.date),1));
    if(next<=D.today()){ this.date=next; this.render(); }
  },
  pickDate(){
    const el = document.getElementById('hidden-date-picker');
    el.max = D.today();
    el.value = this.date;
    el.click();
  },
  onDatePick(v){ if(v){ this.date=v; this.render(); } },
};

// ── UIヘルパー ────────────────────────────────────────────────
const UI = {
  open(id){ document.getElementById(id).classList.add('open'); },
  close(id){ document.getElementById(id).classList.remove('open'); },
  closeIfBg(e,id){ if(e.target.classList.contains('overlay')) this.close(id); },

  openPeriodSheet(){
    document.getElementById('period-date-input').value = D.today();
    this.open('ov-period');
  },

  openMedMgr(){
    const meds = DB.getMeds();
    const el = document.getElementById('med-list-sheet');
    if(meds.length===0){
      el.innerHTML='<div class="text-sm" style="margin-bottom:12px">まだ登録がありません</div>';
    } else {
      el.innerHTML = meds.map((m,i)=>`
        <div class="med-card">
          <div class="med-icon" style="background:${m.type==='injection'?'var(--blue-light)':'var(--purple-light)'}">
            ${{pill:'💊',injection:'💉',patch:'🩹',other:'🏥'}[m.type]||'💊'}
          </div>
          <div class="med-info">
            <div class="med-name">${m.name}</div>
            <div class="med-detail">${m.dosage||''} · 周期${(m.days&&m.days.length?m.days.join(','):`${m.startDay}〜${m.endDay}`)}日目</div>
          </div>
          <div class="toggle ${m.active!==false?'on':''}" onclick="MedForm.toggle(${i},this)"></div>
          <button class="topbar-btn" style="font-size:14px" onclick="MedForm.openEdit(${i})">✏️</button>
        </div>`).join('');
    }
    this.open('ov-med');
  },

  openMedAdd(){
    MedForm.editIdx = null;
    document.getElementById('med-add-title').textContent = '薬・注射を追加';
    document.getElementById('med-name-in').value='';
    document.getElementById('med-dosage-in').value='';
    document.getElementById('med-days-in').value='';
    document.getElementById('med-time-in').value='08:00';
    document.querySelectorAll('#med-type-seg .seg-btn').forEach((b,i)=>b.classList.toggle('sel',i===0));
    this.open('ov-med-add');
  },

  openDoctorSheet(idx=null){
    DoctorForm.editIdx = idx;
    document.getElementById('doctor-sheet-title').textContent = idx==null?'担当医を追加':'担当医を編集';
    document.getElementById('doc-del-btn').classList.toggle('hidden', idx==null);
    if(idx!=null){
      const doc = DB.getDoctors()[idx];
      document.getElementById('doc-name-in').value=doc.name||'';
      document.getElementById('doc-spec-in').value=doc.spec||'';
      DoctorForm.slots = (doc.slots||[]).map(s=>({...s}));
    } else {
      document.getElementById('doc-name-in').value='';
      document.getElementById('doc-spec-in').value='';
      DoctorForm.slots=[];
    }
    DoctorForm.renderSlots();
    this.open('ov-doctor');
  },

  openGcal(){
    const el = document.getElementById('gcal-sheet-content');
    if(App.gcalSignedIn){
      el.innerHTML=`<div class="gcal-banner" style="margin-bottom:16px">
        <span>✅ Googleカレンダー連携中</span></div>
        <p class="text-sm" style="margin-bottom:14px">排卵日・生理予定・服薬予定がGoogleカレンダーの「妊活ノート」カレンダーに自動登録されます。</p>
        <button class="primary-btn" onclick="GCal.syncNow();UI.close('ov-gcal')">今すぐ同期</button>
        <button class="danger-btn" onclick="App.gcalSignOut();UI.close('ov-gcal')">連携を解除</button>`;
    } else {
      el.innerHTML=`<div class="gcal-connect" onclick="GCal.signIn()">
        <div class="gcal-icon">📅</div>
        <div class="gcal-text"><h3>Googleアカウントで連携する</h3><p>排卵日・服薬予定が自動でカレンダーに追加されます</p></div>
        <div style="font-size:20px">›</div>
      </div>
      <p class="text-sm" style="margin-top:12px;line-height:1.7">
        ⚠️ 連携にはGoogle Cloud ConsoleでのOAuth設定が必要です。<br>
        設定方法はREADMEをご覧ください。<br><br>
        クライアントIDを設定後、この画面からログインできます。
      </p>`;
    }
    this.open('ov-gcal');
  },
};

// ── 服薬フォーム ──────────────────────────────────────────────
const MedForm = {
  editIdx: null,
  currentType: 'pill',

  setType(btn){
    document.querySelectorAll('#med-type-seg .seg-btn').forEach(b=>b.classList.remove('sel'));
    btn.classList.add('sel');
    this.currentType = btn.dataset.v;
  },

  toggle(idx, el){
    const meds = DB.getMeds();
    meds[idx].active = !meds[idx].active;
    DB.set('medications', meds);
    el.classList.toggle('on', meds[idx].active);
    HomeUI.render();
  },

  openEdit(idx){
    this.editIdx = idx;
    const m = DB.getMeds()[idx];
    document.getElementById('med-add-title').textContent='薬・注射を編集';
    document.getElementById('med-name-in').value=m.name||'';
    document.getElementById('med-dosage-in').value=m.dosage||'';
    // days配列（新形式）またはstartDay/endDay（旧形式）を表示
    if(m.days && Array.isArray(m.days)){
      document.getElementById('med-days-in').value=m.days.join(',');
    } else {
      document.getElementById('med-days-in').value=`${m.startDay||3}-${m.endDay||7}`;
    }
    document.getElementById('med-time-in').value=m.time||'08:00';
    document.querySelectorAll('#med-type-seg .seg-btn').forEach(b=>{
      b.classList.toggle('sel',b.dataset.v===m.type);
    });
    this.currentType = m.type;
    UI.open('ov-med-add');
  },

  save(){
    const name = document.getElementById('med-name-in').value.trim();
    if(!name) return;

    // days入力をパース（"5,7,9" または "3-7"）
    const daysStr = document.getElementById('med-days-in').value.trim();
    let days = [];
    if(daysStr.includes('-')){
      const parts = daysStr.split('-');
      const start = parseInt(parts[0])||1, end = parseInt(parts[1])||7;
      for(let i=start;i<=end;i++) days.push(i);
    } else {
      days = daysStr.split(',').map(s=>parseInt(s.trim())).filter(n=>!isNaN(n)&&n>0);
    }
    if(days.length===0) days=[1];

    const med = {
      id: Date.now(),
      name,
      type: this.currentType,
      dosage: document.getElementById('med-dosage-in').value.trim()||null,
      days,
      time: document.getElementById('med-time-in').value||'08:00',
      active: true,
    };
    const meds = DB.getMeds();
    if(this.editIdx!=null){ med.id=meds[this.editIdx].id; meds[this.editIdx]=med; }
    else meds.push(med);
    DB.set('medications', meds);
    UI.close('ov-med-add');
    UI.openMedMgr();
    HomeUI.render();
    if(App.gcalSignedIn) GCal.syncNow();
    toast('保存しました');
  },
};

// ── 担当医フォーム ────────────────────────────────────────────
const DoctorForm = {
  editIdx: null,
  slots: [],

  addSlot(){
    this.slots.push({wd:'1', start:'09:00', end:'12:00'});
    this.renderSlots();
  },

  removeSlot(i){
    this.slots.splice(i,1);
    this.renderSlots();
  },

  renderSlots(){
    const wds=['','月','火','水','木','金','土','日'];
    document.getElementById('slot-list-form').innerHTML = this.slots.map((s,i)=>`
      <div class="slot-row">
        <select class="form-input" style="width:60px" onchange="DoctorForm.slots[${i}].wd=this.value">
          ${[1,2,3,4,5,6,7].map(n=>`<option value="${n}" ${s.wd==n?'selected':''}>${wds[n]}</option>`).join('')}
        </select>
        <input type="time" class="form-input" value="${s.start}" onchange="DoctorForm.slots[${i}].start=this.value">
        <span class="text-sm">〜</span>
        <input type="time" class="form-input" value="${s.end}" onchange="DoctorForm.slots[${i}].end=this.value">
        <div class="rm-btn" onclick="DoctorForm.removeSlot(${i})">×</div>
      </div>`).join('');
  },

  save(){
    const name = document.getElementById('doc-name-in').value.trim();
    if(!name) return;
    const doc = {
      id: Date.now(),
      name,
      spec: document.getElementById('doc-spec-in').value.trim(),
      slots: this.slots.map(s=>({wd:Number(s.wd),start:s.start,end:s.end})),
    };
    const doctors = DB.getDoctors();
    if(this.editIdx!=null){ doc.id=doctors[this.editIdx].id; doctors[this.editIdx]=doc; }
    else doctors.push(doc);
    DB.set('doctors', doctors);
    UI.close('ov-doctor');
    DoctorUI.render();
    toast('保存しました');
  },

  del(){
    if(!confirm('削除しますか？')) return;
    const doctors = DB.getDoctors();
    doctors.splice(this.editIdx, 1);
    DB.set('doctors', doctors);
    UI.close('ov-doctor');
    DoctorUI.render();
    toast('削除しました');
  },
};

// ── Google Calendar連携 ───────────────────────────────────────
const GCal = {
  tokenClient: null,
  accessToken: null,
  APP_CAL_NAME: '妊活ノート',

  init(){
    if(!App.gcalClientId) return;
    // Google Identity Services
    const gisScript = document.createElement('script');
    gisScript.src = 'https://accounts.google.com/gsi/client';
    gisScript.onload = ()=>{
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: App.gcalClientId,
        scope: 'https://www.googleapis.com/auth/calendar',
        callback: (resp)=>{ if(resp.access_token){ this.accessToken=resp.access_token; this.onSignedIn(); } },
      });
    };
    document.head.appendChild(gisScript);
  },

  signIn(){
    if(!App.gcalClientId){
      alert('Googleカレンダー連携を使うには、index.html内の App.gcalClientId にGoogle Cloud ConsoleのクライアントIDを設定してください。\n\nREADME.txtをご覧ください。');
      return;
    }
    if(this.tokenClient) this.tokenClient.requestAccessToken();
  },

  async onSignedIn(){
    App.gcalSignedIn = true;
    HomeUI.render();
    UI.openGcal();
    await this.fetchPersonalEvents();
    await this.writePredictions();
    toast('Googleカレンダーと連携しました 📅');
  },

  // 個人予定を読み込む
  async fetchPersonalEvents(){
    if(!this.accessToken) return;
    const now = new Date();
    const from = now.toISOString();
    const to = new Date(now.getTime()+90*24*3600*1000).toISOString();

    try{
      const events = [];
      // ④ 全カレンダーではなく「primary」（本人のメインカレンダー）のみ取得
      // → 共有カレンダー経由で他人の予定が混入するのを防ぐ
      const evRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?`+
        `timeMin=${from}&timeMax=${to}&singleEvents=true&orderBy=startTime&maxResults=100`,
        {headers:{Authorization:'Bearer '+this.accessToken}}
      );
      const evData = await evRes.json();
      for(const e of (evData.items||[])){
        if(e.summary===undefined) continue; // タイトルなしはスキップ
        const startStr = e.start?.dateTime||e.start?.date;
        if(!startStr) continue;
        const date = startStr.length===10 ? startStr : D.ymd(new Date(startStr));
        events.push({id:e.id, date, title:e.summary||'予定'});
      }
      DB.setGcalEvents(events);
    }catch(err){ console.warn('GCal fetch error', err); }
  },

  // 予測・服薬イベントを書き込む
  async writePredictions(){
    if(!this.accessToken) return;
    const p = Predict.run();

    // アプリ専用カレンダーを取得または作成
    const calId = await this.ensureAppCal();
    if(!calId) return;

    const toWrite = [
      {title:'⭐ 排卵予測日', date:p.ovulDate},
      {title:'🔴 生理予定日', date:p.nextPeriod},
      ...p.timingDays.map(d=>({title:'💜 タイミング推奨日', date:d})),
    ];

    for(const ev of toWrite){
      await this.writeEvent(calId, ev.title, ev.date);
    }

    // 服薬・注射
    const meds = DB.getMeds().filter(m=>m.active!==false);
    for(const med of meds){
      for(let day=med.startDay;day<=med.endDay;day++){
        const date = D.ymd(D.addDays(D.parse(p.lastStart), day-1));
        if(date>=D.today()){
          const emoji={pill:'💊',injection:'💉',patch:'🩹',other:'🏥'}[med.type]||'💊';
          await this.writeEvent(calId, `${emoji} ${med.name}${med.dosage?' ('+med.dosage+')':''}`, date);
        }
      }
    }
  },

  async ensureAppCal(){
    try{
      const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList',
        {headers:{Authorization:'Bearer '+this.accessToken}});
      const data = await res.json();
      for(const c of (data.items||[])){
        if(c.summary===this.APP_CAL_NAME) return c.id;
      }
      // 新規作成
      const created = await fetch('https://www.googleapis.com/calendar/v3/calendars',{
        method:'POST',
        headers:{Authorization:'Bearer '+this.accessToken,'Content-Type':'application/json'},
        body:JSON.stringify({summary:this.APP_CAL_NAME, timeZone:'Asia/Tokyo'}),
      });
      const cal = await created.json();
      return cal.id;
    }catch(e){ console.warn(e); return null; }
  },

  async writeEvent(calId, title, date){
    try{
      await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,{
        method:'POST',
        headers:{Authorization:'Bearer '+this.accessToken,'Content-Type':'application/json'},
        body:JSON.stringify({
          summary:title,
          start:{date},
          end:{date},
        }),
      });
    }catch(e){ console.warn(e); }
  },

  async syncNow(){
    await this.fetchPersonalEvents();
    await this.writePredictions();
    Cal.render();
    HomeUI.render();
    toast('同期しました 📅');
  },
};

// ── トースト通知 ──────────────────────────────────────────────
function toast(msg){
  let el = document.getElementById('toast');
  if(!el){
    el = document.createElement('div');
    el.id='toast';
    el.style.cssText='position:fixed;bottom:calc(var(--nav-h) + 16px);left:50%;transform:translateX(-50%);background:#2D1B33;color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;font-weight:500;z-index:9999;opacity:0;transition:opacity .3s;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.25)';
    document.body.appendChild(el);
  }
  el.textContent=msg;
  el.style.opacity='1';
  clearTimeout(el._t);
  el._t=setTimeout(()=>el.style.opacity='0',2500);
}

// ── 起動 ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded',()=>{
  App.init();
  Cal.init();
  GCal.init();
});

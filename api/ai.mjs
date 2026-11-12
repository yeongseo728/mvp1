// 메모 AI로 살펴보기: 사용자가 "보내기"를 누르면 메모(가린 것)와 그 질문 문장, 관련 법률 목록을
// Gemini에 보내고, 위험도 글을 돌려줘요. 질문과 법률 목록은 앱에 원래 있는 글이에요.
// 바깥 서비스는 Gemini API 하나만, 이 파일에서만 불러요.
// 키는 Vercel 설정의 GEMINI_API_KEY에만 있어요. 키 값은 어디에도 적거나 남기지 않아요.
// 받은 메모와 결과는 이 서버에 저장하지 않아요.

const MODEL = 'gemini-3.5-flash-lite';
const MAX_LINES = 20;
const LEVELS = ['위험 높음', '더 확인 필요', '위험 낮음', '판단 어려움'];

// AI에게 줄 지시와 답의 모양
const SYSTEM = [
  '너는 서울에서 혼자 전월세 계약을 앞둔 대학생을 돕는 안내 도우미야.',
  '[질문]은 대학생이 집주인이나 공인중개사에게 확인한 질문이고, [메모]는 그 질문에 대해 들은 말을 대학생이 직접 적은 거야.',
  '메모를 읽고 그 질문에 대한 계약 전 위험도를 판단해 줘. 그리고 왜 위험한지, 또는 왜 위험하지 않은지 알려 줘.',
  '첫 줄은 "' + LEVELS.join('", "') + '" 가운데 하나만 써.',
  '메모만으로 판단하기 어렵거나 전월세 계약과 상관없는 내용이면 "판단 어려움"으로 써.',
  '그다음 줄부터 그렇게 본 이유와, 집주인이나 공인중개사에게 더 확인할 것을 "- "로 시작하는 짧은 줄로 써.',
  '판단은 [관련 법률] 목록에만 기대지 않아도 돼. 일반적인 전월세 계약 주의점과 상식도 함께 보고 판단해.',
  '다만 법률 이름이나 조항 번호는 [관련 법률] 목록에 있는 것만 써. 목록에 없는 법은 이름과 조항 번호 없이 "다른 법 규정"처럼 풀어 써.',
  '답의 모양: 전체 20줄 이내, 쉬운 한국어 존댓말(-요), 한 줄에 한 문장, 가독성이 좋게. 마크다운 굵은 글씨(**)나 표는 쓰지 마.',
  '판례와 숫자는 지어내지 마. 사람 이름과 연락처는 쓰지 마.',
  '법률 자문처럼 단정하지 말고 참고 의견으로 써.'
].join('\n');

/* 목록에 없는 법률 이름 지우기
   AI 답에서 법률 이름으로 보이는 낱말을 찾고, 그 질문의 관련 법률 목록에 없는 이름이 있으면 그 줄을 지워요.
   법률 이름으로 보는 것: "제○조"가 바로 뒤에 붙은 "~법", "보호법·기본법·특별법·중개사법·세법·민법 같은 이름",
   "~에 관한 법률". "방법·불법·위법·적법"처럼 법률이 아닌 낱말은 건드리지 않아요. */
const LAW_TAIL = /(보호법|기본법|특별법|중개사법|등기법|세법|건축법|민법|상법|형법|헌법|촉진법|관리법|규제법|처벌법)$/;
const JOSA = /(에서는|에서|에는|에도|으로|에|의|은|는|이|가|을|를|과|와|상|로|도|만)$/;
const lawWords = s => {
  const out = [];
  const re = /[가-힣]+/g; let m;
  while((m = re.exec(s))){
    let w = m[0];
    const after = s.slice(re.lastIndex);
    if(/^\s*(시행령|시행규칙)?\s*제\s*\d+\s*조/.test(after) && /법$/.test(w)){ out.push(w); continue; }
    if(LAW_TAIL.test(w)){ out.push(w); continue; }
    const stem = w.replace(JOSA, '');
    if(stem !== w && LAW_TAIL.test(stem) && stem.length >= 2) out.push(stem);
  }
  if(/에\s*관한\s*법률/.test(s)) out.push('에 관한 법률');
  return out;
};
const keepLine = (line, allowed) => lawWords(line).every(w => allowed.has(w));

// 전화번호·주민등록번호·계좌번호·이메일처럼 보이는 글자를 가려요 (페이지에서도 한 번 가려서 보내요)
function mask(s){
  return String(s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***')
    .replace(/\d{6}[-\s]?[1-8]\d{6}/g, '***')
    .replace(/0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}/g, '***')
    .replace(/\d(?:[-\s]?\d){9,}/g, '***');
}

// Vercel 로그에 한 줄만 남겨요 (키 값은 넣지 않아요)
const logFail = why => console.error('Gemini 실패 · ' + String(why).replace(/\s+/g, ' ').slice(0, 160));

export default async function handler(req, res){
  if(req.method !== 'POST'){ res.setHeader('Allow', 'POST'); return res.status(405).json({error: 'method'}); }

  let b = req.body;
  if(typeof b === 'string'){ try { b = JSON.parse(b); } catch(e) { b = null; } }
  const memo = mask(b && typeof b.memo === 'string' ? b.memo.trim().slice(0, 300) : '');
  // 빈 글이면 Gemini를 부르지 않아요
  if(!memo) return res.status(400).json({error: 'empty'});
  // 질문 문장과 관련 법률 목록 (앱에 원래 있는 글). 길이와 개수를 제한해요
  const question = b && typeof b.question === 'string' ? b.question.trim().slice(0, 200) : '';
  const laws = (b && Array.isArray(b.laws) ? b.laws : []).slice(0, 10)
    .filter(l => l && typeof l.name === 'string' && l.name.trim())
    .map(l => ({name: l.name.trim().slice(0, 100), desc: typeof l.desc === 'string' ? l.desc.trim().slice(0, 300) : ''}));
  // 목록에 있는 법률 이름 (예: "주택임대차보호법 제3조 (대항력 등)" → "주택임대차보호법")
  const allowed = new Set(laws.flatMap(l => lawWords(l.name)));
  const prompt = (question ? '[질문] ' + question + '\n' : '') +
    '[관련 법률]\n' + (laws.length ? laws.map(l => '- ' + l.name + (l.desc ? ': ' + l.desc : '')).join('\n') : '- (없음)') + '\n' +
    '[메모] ' + memo;

  const key = process.env.GEMINI_API_KEY;
  if(!key){ logFail('GEMINI_API_KEY 없음'); return res.status(500).json({error: 'no_key'}); }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
      body: JSON.stringify({
        systemInstruction: {parts: [{text: SYSTEM}]},
        contents: [{role: 'user', parts: [{text: prompt}]}],
        generationConfig: {temperature: 0.2}
      }),
      signal: ctrl.signal
    });
    if(!r.ok){
      let msg = '';
      try { const e = (await r.json()).error || {}; msg = [e.status, e.message].filter(Boolean).join(': '); } catch(e) {}
      logFail(r.status + (msg ? ' · ' + mask(msg).slice(0, 120) : ''));
      return res.status(502).json({error: 'ai'});
    }
    const data = await r.json();
    // "생각한 내용"(thought) 조각은 건너뛰고 진짜 답 조각만 읽어요
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const raw = parts.filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    // 목록에 없는 법률 이름이 든 줄은 지워요
    // 굵은 글씨 표시(**)를 먼저 지우고 가려요. 반대로 하면 가린 *** 가 * 로 줄어들어요
    const lines = mask(raw.replace(/\*\*/g, '')).split('\n').map(l => l.trimEnd()).filter(l => keepLine(l, allowed));
    while(lines.length && !lines[0].trim()) lines.shift();
    const text = lines.slice(0, MAX_LINES).join('\n').trim();
    if(!text){ logFail(r.status + ' · 빈 답'); return res.status(502).json({error: 'ai'}); }

    const u = data.usageMetadata || {};
    console.log('Gemini 성공 · 보낸 토큰 ' + (u.promptTokenCount || 0) + ' · 받은 토큰 ' + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)));
    return res.status(200).json({text});
  } catch(e) {
    logFail(e.name === 'AbortError' ? '시간 초과' : '연결 오류 · ' + mask(e.message || '').slice(0, 120));
    return res.status(502).json({error: 'ai'});
  } finally {
    clearTimeout(timer);
  }
}

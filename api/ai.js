// 메모 AI로 살펴보기: 사용자가 "보내기"를 누르면 메모를 Gemini에 보내고, 참고 의견만 돌려줘요.
// 키는 Vercel 설정의 GEMINI_API_KEY에만 있어요. 받은 메모와 결과는 어디에도 저장하지 않아요.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const LEVELS = ['high', 'mid', 'low', 'unclear'];

// 전화번호·주민등록번호·계좌번호·이메일처럼 보이는 글자를 가려요 (페이지에서도 한 번 가려서 보내요)
function mask(s){
  return String(s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***')
    .replace(/\d{6}[-\s]?[1-8]\d{6}/g, '***')
    .replace(/0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}/g, '***')
    .replace(/\d(?:[-\s]?\d){9,}/g, '***');
}

const text = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

const SYSTEM = [
  '너는 서울에서 혼자 전월세 계약을 앞둔 대학생을 돕는 안내 도우미야.',
  '사용자가 공인중개사나 집주인에게 들은 말을 적은 메모를 읽고, 계약 전 위험도를 참고 의견으로 알려 줘.',
  '반드시 사용자가 준 "관련 법률" 목록 안의 법률만 근거로 써. 목록에 없는 법률, 판례, 숫자는 지어내지 마.',
  '메모만으로 판단하기 어렵거나 질문과 상관없는 내용이면 level을 "unclear"로 해.',
  'level: high(위험 높음), mid(더 확인 필요), low(위험 낮음), unclear(판단 어려움) 가운데 하나.',
  'reasons: 그렇게 본 이유를 쉬운 한국어 존댓말(-요)로 1~3개, 한 문장씩.',
  'ask: 집주인이나 공인중개사에게 더 물어보거나 받아 둘 것을 1~3개, 한 문장씩.',
  'laws: 근거로 쓴 법률 이름을 목록에 적힌 글자 그대로 0~3개.',
  '사람 이름, 연락처는 결과에 쓰지 마. 법률 자문처럼 단정하지 말고 참고 의견으로 써.'
].join('\n');

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    level: {type: 'STRING', enum: LEVELS},
    reasons: {type: 'ARRAY', items: {type: 'STRING'}},
    ask: {type: 'ARRAY', items: {type: 'STRING'}},
    laws: {type: 'ARRAY', items: {type: 'STRING'}}
  },
  required: ['level', 'reasons', 'ask', 'laws']
};

module.exports = async (req, res) => {
  if(req.method !== 'POST'){ res.setHeader('Allow', 'POST'); return res.status(405).json({error: 'method'}); }
  const key = process.env.GEMINI_API_KEY;
  if(!key) return res.status(500).json({error: 'no_key'});

  let b = req.body;
  if(typeof b === 'string'){ try { b = JSON.parse(b); } catch(e) { b = null; } }
  if(!b || typeof b !== 'object') return res.status(400).json({error: 'body'});

  const memo = mask(text(b.memo, 300));
  const q = text(b.q, 300), answer = text(b.answer, 500), who = text(b.who, 20), how = text(b.how, 20);
  const laws = (Array.isArray(b.laws) ? b.laws : []).slice(0, 6)
    .map(l => ({name: text(l && l.name, 80), desc: text(l && l.desc, 300)})).filter(l => l.name);
  if(!memo || !q || !laws.length) return res.status(400).json({error: 'body'});

  const prompt = [
    '[질문] ' + q,
    '[사용자가 고른 답] ' + (answer || '(없음)'),
    '[누가 · 어떻게 답했나] ' + (who || '(모름)') + ' · ' + (how || '(모름)'),
    '[메모] ' + memo,
    '[관련 법률]',
    ...laws.map((l, i) => (i + 1) + '. ' + l.name + (l.desc ? ': ' + l.desc : ''))
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
      body: JSON.stringify({
        systemInstruction: {parts: [{text: SYSTEM}]},
        contents: [{role: 'user', parts: [{text: prompt}]}],
        generationConfig: {temperature: 0.2, responseMimeType: 'application/json', responseSchema: SCHEMA}
      }),
      signal: ctrl.signal
    });
    if(!r.ok){
      // 왜 거절했는지만 짧게 돌려줘요 (키는 넣지 않아요)
      let why = '';
      try { const e = (await r.json()).error || {}; why = mask(text(e.status, 40) + (e.message ? ' · ' + text(e.message, 120) : '')); } catch(e) {}
      return res.status(502).json({error: 'ai', status: r.status, why});
    }
    const data = await r.json();
    // "생각한 내용"(thought) 조각은 건너뛰고 진짜 답 조각만 읽어요
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const answer = parts.filter(p => p && !p.thought && typeof p.text === 'string').pop();
    const raw = answer && answer.text;
    let out;
    try { out = JSON.parse(raw); } catch(e) { return res.status(502).json({error: 'ai_format'}); }

    // AI가 보낸 결과도 한 번 더 걸러요: 정해진 위험도만, 목록에 있는 법률 이름만
    const list = (v, max) => (Array.isArray(v) ? v : []).map(s => mask(text(s, 200))).filter(Boolean).slice(0, max);
    const names = laws.map(l => l.name);
    return res.status(200).json({
      level: LEVELS.includes(out && out.level) ? out.level : 'unclear',
      reasons: list(out && out.reasons, 3),
      ask: list(out && out.ask, 3),
      laws: list(out && out.laws, 3).filter(n => names.includes(n))
    });
  } catch(e) {
    return res.status(502).json({error: e.name === 'AbortError' ? 'timeout' : 'ai'});
  } finally {
    clearTimeout(timer);
  }
};

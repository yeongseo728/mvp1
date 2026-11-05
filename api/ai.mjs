// 메모 AI로 살펴보기: 사용자가 "보내기"를 누르면 메모만 Gemini에 보내고, 위험도 글을 돌려줘요.
// 바깥 서비스는 Gemini API 하나만, 이 파일에서만 불러요.
// 키는 Vercel 설정의 GEMINI_API_KEY에만 있어요. 키 값은 어디에도 적거나 남기지 않아요.
// 받은 메모와 결과는 어디에도 저장하지 않아요.

const MODEL = 'gemini-3.5-flash-lite';
const MAX_LINES = 20;

// AI에게 줄 지시와 답의 모양
const SYSTEM = [
  '너는 서울에서 혼자 전월세 계약을 앞둔 대학생을 돕는 안내 도우미야.',
  '사용자가 직접 입력한 메모를 읽고 계약 전 위험도를 판단해 줘. 그리고 왜 위험한지, 또는 왜 위험하지 않은지 알려 줘.',
  '첫 줄은 "위험도: 높음", "위험도: 보통", "위험도: 낮음", "위험도: 판단 어려움" 가운데 하나만 써.',
  '메모만으로 판단하기 어렵거나 전월세 계약과 상관없는 내용이면 "위험도: 판단 어려움"으로 써.',
  '그다음 줄부터 그렇게 본 이유와, 집주인이나 공인중개사에게 더 확인할 것을 "- "로 시작하는 짧은 줄로 써.',
  '답의 모양: 전체 20줄 이내, 쉬운 한국어 존댓말(-요), 한 줄에 한 문장, 가독성이 좋게. 마크다운 굵은 글씨(**)나 표는 쓰지 마.',
  '법 조항, 판례, 숫자는 지어내지 마. 사람 이름과 연락처는 쓰지 마.',
  '법률 자문처럼 단정하지 말고 참고 의견으로 써.'
].join('\n');

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
        contents: [{role: 'user', parts: [{text: '[메모] ' + memo}]}],
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
    const lines = mask(raw).replace(/\*\*/g, '').split('\n').map(l => l.trimEnd());
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

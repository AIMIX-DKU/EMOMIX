# GPU 워커 연동 가이드 (AI 담당용)

백엔드는 서버리스(Vercel)라 GPU 서버로 요청을 **밀어 넣지 않습니다**. GPU 서버가 API에 와서 작업을 **가져가는(pull)** 방식입니다.
GPU 서버는 외부에서 들어오는 포트를 열 필요가 없고, 아웃바운드 HTTPS만 있으면 됩니다.

- Base URL: `https://<배포주소>/api/v1` (로컬: `http://localhost:3000/api/v1`)
- 인증: 모든 요청에 헤더 `X-Worker-Key: <WORKER_API_KEY>` (쿠키·CSRF 없음). 키는 백엔드 담당에게 받으세요.
- 응답 형식은 다른 API와 같습니다: `{ "success", "message", "data", "errorCode" }`

## 전체 흐름

```
loop:
  1. POST /worker/jobs/claim            → 작업 1개를 받음 (없으면 data.job = null)
  2. 입력 이미지 다운로드               (inputImageUrls, 서명 URL 15분)
  3. 생성 중 주기적으로(30초 이내)
     POST /worker/jobs/{id}/heartbeat   → 진행률 보고 + 임대 연장
  4. POST /worker/jobs/{id}/upload-urls → 결과를 올릴 URL 발급
  5. 각 결과 이미지를 uploadUrl 에 PUT  (Content-Type: image/png)
  6. POST /worker/jobs/{id}/complete    → 완료 보고
     (실패 시) POST /worker/jobs/{id}/fail
```

## 1. 작업 가져오기

`POST /worker/jobs/claim`

```json
{ "workerId": "gpu-01", "types": ["CHARACTER_CANDIDATES", "EMOTION_SET", "EMOTION_REGENERATE", "INPAINT"] }
```
`types` 는 생략하면 전부 처리합니다. 응답:

```json
{ "success": true, "data": { "job": {
  "jobId": "…", "type": "EMOTION_SET",
  "prompt": "공통 프롬프트(그림체 + 캐릭터 외형)",
  "inputImageUrls": ["https://… 기준 캐릭터 이미지 등"],
  "maskImageUrl": null,
  "params": { "count": 2, "items": [ { "emoticonId": "…", "label": "happy", "prompt": "happy smiling joyful" } ] },
  "leaseExpiresAt": "2026-11-17T12:02:00Z"
} } }
```
대기 작업이 없으면 `data.job` 이 `null` 입니다. **한 번에 한 작업**만 받습니다(여러 워커가 동시에 호출해도 같은 작업을 받지 않습니다).

### 작업 종류별 의미
| type | 입력 | 결과 이미지 수 |
| --- | --- | --- |
| `CHARACTER_CANDIDATES` | `prompt`, `inputImageUrls`(참고 이미지, 없을 수 있음) | `params.count` 장(최대 4) |
| `EMOTION_SET` | `prompt`(공통), `inputImageUrls[0]`=기준 캐릭터, `params.items[]` 감정별 프롬프트 | `items` 개수만큼. 각 이미지에 `label` 을 붙여 완료 보고 |
| `EMOTION_REGENERATE` | `inputImageUrls`=[기준 캐릭터, 현재 버전 이미지], `items[0].prompt` | 1장 |
| `INPAINT` | `inputImageUrls[0]`=원본, `maskImageUrl`(흰색=다시 그릴 영역), `prompt` | 1장 |

- 프롬프트는 **백엔드가 완성해서** 넘깁니다(그림체 + 캐릭터 외형 + 감정 + 사용자 추가 요청). 워커는 그대로 모델에 넣으면 됩니다. 영어/한국어 변환이 필요하면 워커에서 처리하세요.
- INPAINT 는 마스크 밖 영역을 **백엔드가 원본 픽셀로 다시 합성**합니다(완료 후 후처리). 워커는 전체 이미지를 만들어 올리면 됩니다. 결과 크기는 원본과 달라도 됩니다(백엔드가 맞춥니다).

## 2. 임대(lease)와 진행 보고

작업을 받으면 **2분의 임대 시간**이 생깁니다. `heartbeat` 를 호출할 때마다 2분씩 연장됩니다.
임대가 끝나도록 호출이 없으면 작업은 자동으로 대기열로 돌아가 다른 워커가 가져가고(최대 3회 시도), 3회 모두 실패하면 `TIMEOUT` 으로 실패 처리됩니다.

`POST /worker/jobs/{jobId}/heartbeat` — `{ "progress": 40 }` → `{ "leaseExpiresAt": "…", "cancelRequested": false }`

- 이미지 한 장이 오래 걸리면 **30~60초마다** 호출하세요.
- 이미 임대가 끝난 작업에 호출하면 `409 LEASE_EXPIRED`. 이때는 작업을 버리고 다음 `claim` 으로 가세요.

## 3. 결과 올리기

1. `POST /worker/jobs/{jobId}/upload-urls` — `{ "count": 4 }` → `uploads: [{ "uploadKey": "…", "uploadUrl": "https://…" }]`
2. 각 이미지를 `PUT {uploadUrl}` (헤더 `Content-Type: image/png`, 본문은 PNG 바이트). **PNG만** 지원합니다. 파일은 API 서버를 거치지 않고 스토리지로 바로 올라갑니다.
3. `POST /worker/jobs/{jobId}/complete`
```json
{ "images": [ { "uploadKey": "…", "label": "happy" }, { "uploadKey": "…", "label": "thanks" } ] }
```
`label` 은 `EMOTION_SET` 에서 `params.items[].label` 과 같은 값을 넣습니다(생략하면 순서대로 매칭). 서버가 파일이 실제 이미지인지 검사하고, 크레딧을 확정합니다.

## 4. 실패 보고

`POST /worker/jobs/{jobId}/fail`
```json
{ "reason": "GPU_ERROR", "message": "CUDA OOM" }
```
`reason`: `GPU_ERROR` · `OUT_OF_MEMORY` · `CONTENT_BLOCKED`(모델 안전 필터에 걸림) · `CANCELED`.
실패하면 사용자의 예약 크레딧이 자동으로 반환됩니다. `heartbeat` 응답의 `cancelRequested` 가 `true` 면 작업을 멈추고 `CANCELED` 로 보고하세요.

## 5. 폴링 주기와 깨우기 알림 (중요)

DB(Neon 무료 플랜)가 쿼리가 없을 때 꺼지는 방식이라, **`claim` 을 2~3초마다 계속 호출하면 DB가 24시간 켜져 있어 무료 시간을 다 씁니다.** 아래 중 하나로 운영하세요.

- **(권장) 깨우기 알림 사용**: 워커가 작은 HTTP 엔드포인트를 열어 두면, 사용자가 생성을 요청할 때 백엔드가 `POST {WORKER_NOTIFY_URL}` 로 짧은 알림을 보냅니다. 알림을 받으면 `claim` 을 호출해 작업이 없을 때까지 반복하고, 이후엔 쉽니다.
  - 알림 요청 헤더: `X-Notify-Timestamp`(ms), `X-Notify-Signature` = `HMAC-SHA256(WORKER_API_KEY, timestamp)` 의 hex. 서명과 시간(±60초)을 검증하세요.
  - 알림을 놓쳐도 되도록 **시작할 때 한 번, 그리고 5~10분마다 한 번** `claim` 을 호출하세요.
  - 이 엔드포인트는 외부에서 접근 가능해야 합니다(Cloudflare Tunnel, ngrok 등). 불가능하면 아래 방식을 쓰세요.
- **알림 없이 폴링**: 시연·테스트 때만 워커를 켜고, 폴링 간격을 **5초 이상**으로 하세요. 워커가 꺼져 있으면 작업은 대기열에 쌓이고 `GET /health` 의 `generationWorker` 가 `DOWN` 으로 보입니다.

`GET /health` (인증 없음)로 `{ status, generationWorker: UP|DOWN, queueLength }` 를 확인할 수 있습니다. 워커가 최근 30초 안에 `claim`/`heartbeat` 를 호출했으면 `UP` 입니다.

## 6. 에러 코드

| HTTP | errorCode | 의미 |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | `X-Worker-Key` 없음/불일치 |
| 409 | `LEASE_EXPIRED` | 임대가 끝났거나 이미 끝난 작업(다른 워커에 재배정되었을 수 있음) |
| 400 | `VALIDATION_ERROR` | 요청 값 오류, 업로드되지 않은 파일, 이미지가 아닌 파일 |
| 404 | `NOT_FOUND` | 없는 작업 |

## 7. 참고 구현 (Python)

```python
import time, requests

API = "http://localhost:3000/api/v1"
H = {"X-Worker-Key": "<WORKER_API_KEY>"}

def call(path, body):
    r = requests.post(f"{API}/worker/jobs{path}", json=body, headers=H, timeout=30)
    return r.json()

while True:
    job = call("/claim", {"workerId": "gpu-01"})["data"]["job"]
    if not job:
        time.sleep(10)          # 알림 없이 폴링할 때: 5초 이상
        continue
    try:
        images = generate(job)  # 팀에서 구현: [(label, png_bytes), ...]
        ups = call(f"/{job['jobId']}/upload-urls", {"count": len(images)})["data"]["uploads"]
        done = []
        for (label, png), up in zip(images, ups):
            requests.put(up["uploadUrl"], data=png, headers={"Content-Type": "image/png"}).raise_for_status()
            done.append({"uploadKey": up["uploadKey"], "label": label})
        call(f"/{job['jobId']}/complete", {"images": done})
    except Exception as e:
        call(f"/{job['jobId']}/fail", {"reason": "GPU_ERROR", "message": str(e)[:200]})
```

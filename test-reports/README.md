# 테스트 보고서 보관함

앱의 **테스트 보고서 → 전체 내보내기**로 받은 JSON 파일을 이 폴더에 넣으면 평가 도구가 읽습니다.

- `split: "training"` (학습): 감도 등 설정값을 고르는 데만 사용
- `split: "validation"` (검증): 정확도를 판단하는 데만 사용. 설정을 고를 때는 절대 보지 않음

```bash
node tools/evaluate.mjs            # 현재 설정으로 학습·검증 각각 채점
node tools/evaluate.mjs --tune     # 학습 데이터로만 설정값 탐색 → 검증 데이터로 확인
```

## AgentCodeGUI 3.1.2

분할 수를 줄일 때 기존 대화가 빈 패널로 바뀌어 보이던 문제를 수정했습니다.

### 수정

- **분할 축소 시 기존 대화 유지** — 5번 패널을 선택한 상태에서 5→4분할로 줄이면 기존 4번 대화가 접히던 문제를 수정했습니다. 이제 기존 1~4번 대화는 그대로 유지되고 5번만 접힙니다. 2~6분할 전환은 표시 순서를 유지하며, 다시 늘리면 접힌 대화와 작성 중인 초안이 그대로 돌아옵니다.
- **1분할에서 원래 배치로 복귀** — 1분할에서는 선택한 대화를 보여 주고, 다시 여러 분할로 돌아가면 원래 순서를 복원합니다. 선택했던 대화가 앞쪽 패널을 밀어내지 않도록 수정했습니다.

---

## AgentCodeGUI 3.1.2 (English)

Fixed existing conversations appearing to be replaced by a blank panel when reducing the panel count.

### Fixes

- **Keep existing conversations when reducing panels** — Switching from five panels to four used to fold conversation 4 when panel 5 was selected. Conversations 1–4 now stay in place and only panel 5 folds. Changes between two and six panels preserve display order; expanding again restores folded conversations and unsent drafts.
- **Restore the original layout after single-panel view** — Single-panel view shows the selected conversation. Returning to multiple panels restores the original order, so that conversation no longer displaces an earlier panel.

"use client";
import { useState } from "react";
import { Modal } from "./modal";
import { McpConnections } from "./mcp-connections";
export function AssistHelp() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        사용법
      </button>
      {open && (
        <Modal title="AI 도움 사용법" onClose={() => setOpen(false)}>
          <ol>
            <li>내 기록에서 주제·분야·도서·태그 등을 고릅니다.</li>
            <li>
              도움 방향을 고르고 <strong>분석할 기록 확인</strong>을 누릅니다.
            </li>
            <li>전송할 기록과 발췌 범위를 확인하고 요청합니다.</li>
            <li>
              아래 요청 목록을 눌러 제안과 근거를 읽습니다. 원하는 항목만
              저장합니다.
            </li>
          </ol>
          <details>
            <summary>어떤 도움을 받을 수 있나요?</summary>
            <p>
              종합 검토는 메모 간 연결, 주제 간 연결, 새로운 주제, 글감과 목차
              방향을 제안합니다. 단어만 비슷한 자료보다 서로 보완하거나 다른
              관점을 드러내는 기록을 찾도록 요청합니다. AI는 생각을 확정하는
              사람이 아닙니다.
            </p>
            <p>
              연결 확정은 실제 메모·주제 관계로 저장합니다. 새 주제는 관련
              기록을 분류합니다. 글감은 메모 상자의 글감 묶음으로 저장하며 당시
              원문과 출처를 보존합니다. 원본 메모를 AI 문장으로 바꾸지 않습니다.
            </p>
          </details>
          <details>
            <summary>분석 범위와 모델</summary>
            <p>
              현재 필터에 맞는 최대 200개 후보에서 서로 다른 주제와 시기의 대표
              기록을 최대 24개 고릅니다. 긴 기록은 검색어 주변 또는 앞부분을
              발췌하고, 합계 약 10,000자 안에서 보냅니다. 전송 확인에 표시하지
              않은 책이나 PDF 전체를 읽었다고 간주하지 마세요.
            </p>
            <p>
              모델 선택은 접힌 설정에서 바꿉니다. 기본 GPT-6 Luna와 깊은 검토용
              GPT-6.1 Sol 모두 추론을 사용합니다. 선택은 이 기기에 저장됩니다.
              계정별 모델 접근 권한과 기존 요청·월 사용 한도를 적용하며,
              실패했다고 다른 모델을 자동 재호출하지 않습니다.
            </p>
          </details>
          <details>
            <summary>요청 삭제와 비용 확인</summary>
            <p>
              목록 오른쪽 휴지통은 완료된 요청을 숨깁니다. 이미 확정한
              메모·주제·글감과 비용 기록은 남습니다. 대기 중인 요청은 취소할 수
              있지만, 전송 중인 요청은 처리가 끝나야 삭제할 수 있습니다.
            </p>
            <p>
              ChatGPT 구독과 API 요금은 별도입니다. 월 사용 한도는 유지합니다.
              건당 한도를 넘으면 표시된 금액으로 직접 조정한 뒤 요청할 수
              있습니다. 한도 조정만으로 AI를 호출하지 않습니다. 응답이나 비용이
              불확실하면 자동 재전송하지 않고, 해당 요청의 세부 화면에서 사용
              내역을 확인합니다.
            </p>
          </details>
          <details>
            <summary>ChatGPT 연결 관리</summary>
            <McpConnections />
          </details>
        </Modal>
      )}
    </>
  );
}

"use client";
import { useState } from "react";
import { Modal } from "./modal";
import { McpConnections } from "./mcp-connections";
export function AssistHelp() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="secondary"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        사용법
      </button>
      {open && (
        <Modal title="AI 도움 사용법" onClose={() => setOpen(false)}>
          <ol>
            <li>내 기록에서 주제·분야·도서·태그 등을 고릅니다.</li>
            <li>
              도움 방향을 고르고 <strong>분석</strong>을 누릅니다. 기록
              입력창에서는 <strong>빈 항목 추천</strong>을 누릅니다.
            </li>
            <li>
              선택한 범위의 기록이 AI에 전달됩니다. 내가 요청한 도움에서 결과를
              확인하고 원하는 항목을 저장합니다.
            </li>
          </ol>
          <details>
            <summary>어떤 도움을 받을 수 있나요?</summary>
            <p>
              내 기록에서는 메모 연결을, 메모 상세에서는 메모 제목을 제안합니다.
              연결된 메모에서는 추가 연결과 전체 제목·연결 이유를,
              생각묶음에서는 제목과 설명을 추천받을 수 있습니다. 단어만 비슷한
              기록을 무조건 연결하지 않으며, 서로 보완하거나 다른 관점을
              보여주는 근거를 확인합니다.
            </p>
            <p>
              연결 확정은 실제 메모 연결에 반영됩니다. 제목 추천을 적용하면
              제목과 설명 입력칸이 채워집니다. 내용을 확인한 뒤 해당 편집
              화면에서 저장하세요. 기록 입력창은 제목·주제·태그 중 비어 있는
              항목을 채울 수 있습니다.
            </p>
          </details>
          <details>
            <summary>분석 범위와 모델</summary>
            <p>
              현재 필터에 맞는 최대 200개 후보에서 서로 다른 주제와 시기의 대표
              기록을 최대 24개 고릅니다. 긴 기록은 검색어 주변 또는 앞부분을
              발췌하고, 합계 약 10,000자 안에서 보냅니다.
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
              목록 오른쪽 휴지통은 완료된 요청을 숨깁니다. 이미 확정한 메모
              연결·생각묶음과 비용 기록은 남습니다. 대기 중인 요청은 취소할 수
              있지만, 전송 중인 요청은 처리가 끝나야 삭제할 수 있습니다.
            </p>
            <p>
              요청당·월별 사용 한도 내에서 분석합니다. 한도 안내가 나오면
              모델이나 분석 범위를 줄여 다시 시도할 수 있습니다. 완료된 요청의
              사용 내역은 요청 상세에서 확인할 수 있습니다.
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

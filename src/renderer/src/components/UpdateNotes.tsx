import { ReactNode, useEffect, useRef, useState } from 'react'
import { getPref, setPref } from '../lib/prefs'
import { SEEN_KEY, seriesOf } from './WhatsNew'

// 업데이트 패치노트 — 마이너 버전이 오를 때마다(1.0 → 1.1, 1.2 …) 첫 실행에 한 번 뜬다.
// 1.1.x처럼 패치(x)만 오르는 건 같은 시리즈라 다시 띄우지 않는다. 새 설치(도장 없음)는
// 여기가 아니라 WhatsNew(전체 기능 소개)가 맡으므로, 도장이 "있고" 시리즈가 바뀐
// 경우에만 연다. 두 화면은 같은 SEEN_KEY를 읽고 써서 같은 실행에 겹쳐 뜨지 않는다.
//
// 비주얼은 "3D 크리에이터 포트폴리오" 레퍼런스를 우리 패치노트로 옮긴 것 —
// 칠흑(#0C0C0C) 무대 + Kanit, 위→아래 메탈 그라데이션 대제목(#646973 → #BBCCD7),
// 키워드 마퀴, 그리고 변경점을 01·02·03…의 "넘버드 리스트"로 (포트폴리오의 서비스
// 섹션처럼) 한 줄씩 스크롤로 떠오르게 쌓는다. 레퍼런스 맨 앞의 인물 포트레이트는 뺐다.
// 색은 컨셉 고정값이라 테마 변수를 쓰지 않는다.

type Note = { num: string; tag: string; name: ReactNode; desc: ReactNode }
type Release = { title: string; lead: string; notes: Note[] }

// 시리즈('1.1')별 패치노트. 다음 마이너에선 여기에 한 덩이만 더 얹으면 된다.
const RELEASES: Record<string, Release> = {
  '1.6': {
    title: "WHAT'S NEW",
    lead: '코드는 그대로 두고, 옆에서 따로 물어보세요 — 1.6.',
    notes: [
      {
        num: '01',
        tag: '창 · 추가 채팅',
        name: '코드 옆, 또 하나의 대화',
        desc: (
          <>
            사이드바 <b>추가 채팅</b>(또는 <b>Ctrl+Shift+N</b>)으로 <b>독립된 대화 창</b>을 하나 더
            띄워요 — 지금 하던 코드 작업은 그대로 두고, 이 창에서 따로 물어보면 됩니다. <b>크기 조절·
            다른 모니터로 옮기기</b>가 자유롭고, 모델·강도 선택과 <b>파일 첨부</b>, 할 일·서브에이전트·
            파일·컨텍스트까지 본 채팅과 똑같이 갖췄어요. 창마다 <b>완전히 독립</b>된 세션이라 서로
            간섭하지 않습니다.
          </>
        )
      },
      {
        num: '02',
        tag: '대화 · 검색',
        name: '긴 대화도, 바로 찾기',
        desc: (
          <>
            채팅 안에서 <b>Ctrl+F</b>로 <b>대화 내용을 검색</b>해요 — 일치하는 곳이 노랗게, 현재 위치는
            또렷하게 칠해지고 <b>Enter로 다음 · Shift+Enter로 이전</b>으로 넘겨봅니다. 답변이 흘러나오는
            중에도 흐트러지지 않아요.
          </>
        )
      },
      {
        num: '03',
        tag: '빠른 질문 · 첨부',
        name: '/ask에도, 파일을',
        desc: (
          <>
            <b>/ask</b> 빠른 질문에도 <b>이미지·텍스트 파일을 첨부</b>할 수 있어요 — 클립 버튼,
            <b>드래그&amp;드롭</b>, <b>붙여넣기</b> 모두 본 채팅과 똑같이 동작합니다.
          </>
        )
      },
      {
        num: '04',
        tag: '뷰어 · 마크다운',
        name: '문서는, 문서답게',
        desc: (
          <>
            변경된 <b>.md 파일</b>을 열면 이제 <b>렌더링된 문서</b>가 먼저 보여요. 변경 내용을 줄 단위로
            확인하고 싶으면 <b>Ctrl+D</b>로 <b>렌더 ↔ 변경(diff) 소스</b>를 오갑니다.
          </>
        )
      },
      {
        num: '05',
        tag: '계정 · 로그인',
        name: '여러 계정, 자유롭게',
        desc: (
          <>
            설정 <b>Account</b> 탭에서 <b>클로드 구독 계정을 여러 개 등록</b>해두고 <b>변경</b>으로 언제든
            전환해요 — 로그인/로그아웃은 브라우저로, 계정 크리덴셜은 <b>암호화(DPAPI)</b>되어 저장됩니다.
            이제 계정마다 <b>남은 한도(5시간·주간·Fable)</b>가 함께 보여서 <b>여유 있는 계정을 골라</b>{' '}
            갈아탈 수 있고, 전환이 이전 계정으로 <b>되돌아가던 문제</b>도 뿌리부터 바로잡았어요.
          </>
        )
      },
      {
        num: '06',
        tag: '추가 채팅 · 빠른 질문',
        name: '어느 창에서든, /ask',
        desc: (
          <>
            <b>추가 채팅 창에서도 /ask</b>가 열려요 — 창마다 <b>자기 전용 엔진</b>이라 본 대화도, 다른
            창도 건드리지 않습니다. 첨부·모델 선택·실행 중 즉시 열기까지 본 채팅의 /ask와 똑같아요.
          </>
        )
      },
      {
        num: '07',
        tag: '추가 채팅 · 읽기',
        name: '본 채팅처럼, 읽기 좋게',
        desc: (
          <>
            추가 채팅도 이제 <b>Ctrl+휠로 글자 크기</b>를 조절해요 — 본 채팅에서 정해둔 크기가
            그대로 이어집니다. 메시지가 창 양끝까지 퍼지던 것도 본 채팅과 같은{' '}
            <b>가운데 정렬 폭</b>으로 읽기 좋게 바뀌었고, 창을 좁히면 폭에 맞춰 자연스럽게
            줄어들어요.
          </>
        )
      }
    ]
  },
  '1.5': {
    title: "WHAT'S NEW",
    lead: '크래시를 뿌리부터 잡고, 오래 켜둬도 가볍게 — 1.5.',
    notes: [
      {
        num: '01',
        tag: '안정성 · 크래시',
        name: '큰 파일에도, 끄떡없이',
        desc: (
          <>
            에이전트가 <b>큰 파일을 편집</b>할 때 변경 diff 계산이 <b>메모리를 폭발</b>시켜 앱이
            통째로 꺼지던 문제를 뿌리부터 고쳤어요 — 이제 2만 줄 파일도 <b>수십 ms</b>에 처리돼요.
            분석 서버가 갑자기 죽을 때 앱까지 끌어내리던 경로, 타이머·비동기 예외까지 막아{' '}
            <b>기능 하나가 삐끗해도 앱은 살아</b> 있습니다.
          </>
        )
      },
      {
        num: '02',
        tag: '안정성 · 메모리',
        name: '오래 켜둬도, 가볍게',
        desc: (
          <>
            긴 대화나 멀티 패널에서 메시지·도구 기록·diff가 <b>끝없이 쌓여</b> 점점 느려지고
            끝내 화면이 하얘지던 걸 <b>상한</b>으로 정리했어요. 여러 패널을 오래 돌려도{' '}
            <b>메모리가 평탄</b>하게 유지되고, 이미지 뷰어와 코드 색칠 캐시도 필요한 만큼만 씁니다.
          </>
        )
      },
      {
        num: '03',
        tag: '안정성 · 복구',
        name: '갑자기 꺼져도, 안전하게',
        desc: (
          <>
            대화·설정 <b>저장을 원자적으로</b> 바꿔 저장 도중 꺼져도 파일이 반쪽으로 깨지지
            않아요. 손상된 기록은 <b>스스로 걸러</b> 읽고, 한 화면에서 오류가 나도{' '}
            <b>복구 카드</b>로 감싸 앱 전체가 백지가 되지 않습니다 — 한 번의 크래시가 다음 실행까지
            망가뜨리던 악순환을 끊었어요.
          </>
        )
      },
      {
        num: '04',
        tag: '코드 뷰어',
        name: 'diff는, 원할 때만',
        desc: (
          <>
            코드 뷰어의 <b>변경 색칠(초록/빨강)이 기본은 꺼진</b> 채로 열려요 — 그냥 읽을 땐
            깔끔하게, 변경점을 보고 싶을 땐 <b>Ctrl+D</b>로 켜면 됩니다. 어떤 파일이 바뀌었는지는
            변경 파일 목록·탐색기 배지로 그대로 보여요.
          </>
        )
      },
      {
        num: '05',
        tag: '과금 · 안내',
        name: 'API 과금, 놓치지 않게',
        desc: (
          <>
            <b>API 크레딧으로 과금</b>되는 실행이면 보낸 메시지 <b>바로 위에 한 번</b> 알려줘요 —
            실수로 과금을 API로 켜둔 걸 바로 알아채도록. 전역 <b>환경변수(ANTHROPIC_API_KEY)</b>로
            몰래 과금되는 경우도 잡아 <b>사용액 통계에 반영</b>되고, 안내문의 <b>과금·구독</b>은
            색으로 또렷하게 가리켜요.
          </>
        )
      },
      {
        num: '06',
        tag: '엔진 · 정리',
        name: '이전 버전은, 한 번에',
        desc: (
          <>
            설정 ▸ Claude Code에서 <b>최신 엔진만 남기고 이전 버전을 한 번에 삭제</b>할 수 있어요 —
            확인 카드로 한 번 묻고, 끝나면 <b>몇 개를 지웠고 디스크를 얼마나 확보했는지</b>까지
            알려줍니다. 사용 중인 버전이 지워지면 최신으로 안전하게 전환돼요.
          </>
        )
      },
      {
        num: '07',
        tag: 'Verse · 호버',
        name: 'override에도, 공식 문서가',
        desc: (
          <>
            <b>OnBegin&lt;override&gt;()</b> 같은 재정의 선언에 호버하면 이제 <b>원본 선언의 공식
            문서</b>(한국어 번역 포함)가 함께 떠요 — 재정의 위엔 주석이 없어 설명이 통째로 비던
            자리입니다. 내 클래스 계층에서도 <b>가장 가까운 조상</b>의 주석을 찾아 보여주고, 직접
            주석을 달면 그게 우선이에요.
          </>
        )
      },
      {
        num: '08',
        tag: '웹 검색 (1.5.3)',
        name: '어디를 찾아봤는지, 한눈에',
        desc: (
          <>
            채팅의 <b>Web 행을 클릭</b>하면 검색이 찾은 페이지 목록이 <b>파비콘 · 제목 · 도메인</b>{' '}
            카드로 펼쳐져요 — 각 항목을 누르면 <b>브라우저로 바로</b> 열립니다. URL 하나짜리 행은
            클릭 한 번에 그 페이지로.
          </>
        )
      },
      {
        num: '09',
        tag: '채팅 · 스크롤 (1.5.3)',
        name: '읽던 자리는, 그대로',
        desc: (
          <>
            멀티 모드에 갔다 와도 채팅 스크롤이 <b>맨 위로 튀지 않고</b> 읽던 자리(또는 맨
            아래)로 돌아와요. 위로 올라가 읽는 중엔 <b>맨 아래로</b> 버튼이 떠서 한 번에
            최신 메시지로 내려갑니다.
          </>
        )
      },
      {
        num: '10',
        tag: '멀티 · 과금 (1.5.3)',
        name: '구독도 API도, 한 헤더에',
        desc: (
          <>
            패널 절반은 구독, 절반은 API여도 헤더에 <b>구독 N · 한도 링</b>과 <b>API N · 누적
            사용액/남은 예산</b>이 나란히 보여요 — 혼합일 때만 그룹 태그가 붙어 어느 패널들
            몫인지 구분됩니다.
          </>
        )
      },
      {
        num: '11',
        tag: '채팅 모드 (1.5.3)',
        name: '채팅에도, 작업 바',
        desc: (
          <>
            채팅 모드에도 코드 모드와 같은 <b>작업 바</b>(할 일 · 서브에이전트 · 변경된 파일 ·
            컨텍스트)가 생겼어요 — 변경 파일을 누르면 <b>코드 뷰어</b>가, 서브에이전트를 누르면
            <b>작업 카드</b>가 열립니다.
          </>
        )
      },
      {
        num: '12',
        tag: '목록 관리 (1.5.4)',
        name: '한 번에, 비우기',
        desc: (
          <>
            사이드바의 <b>최근 채팅/작업</b> 라벨 옆 휴지통으로 목록을 <b>한 번에 삭제</b>할 수
            있어요 — 확인 카드로 한 번 묻고, 빈 새 채팅 하나로 깔끔하게 시작합니다. 세 모드
            모두에서요.
          </>
        )
      },
      {
        num: '13',
        tag: '멀티 · 손질 (1.5.4)',
        name: '멀티, 결대로',
        desc: (
          <>
            실행 중인 패널에서 <b>Esc는 이제 그 패널의 실행 취소</b>예요(선택 해제가 아니라).
            폴더를 안 고른 패널은 약속대로 <b>바탕화면에서 바로 실행</b>되고 — 폴더 대화상자가
            끼어들지 않아요 — 긴 경로의 폴더 칩 툴팁이 화면 밖으로 잘리던 것도 고쳤습니다.
          </>
        )
      },
      {
        num: '14',
        tag: '언어 공통 (1.5.5)',
        name: '모든 언어에, 용어집',
        desc: (
          <>
            Verse에만 있던 디테일을 전 언어로 — <b>TS/JS · Python · C# · C++</b>의 키워드·내장
            타입(<b>if · override · int · number…</b>)에 한국어 설명 호버가 떠요. TS/Python 호버
            카드도 <b>구조화</b>되고, 자동완성은 <b>함수 괄호 삽입</b>과 <b>문서 지연 로드</b>까지.
            서버 설치 전에도 키워드 호버는 바로 동작합니다.
          </>
        )
      },
      {
        num: '15',
        tag: '언리얼 C++ (1.5.5)',
        name: '언리얼 C++, Verse처럼',
        desc: (
          <>
            <b>UPROPERTY · UCLASS</b> 같은 리플렉션 매크로와 <b>VisibleAnywhere ·
            BlueprintCallable</b> 같은 지정자에 호버 설명이 붙고, <b>{'UPROPERTY('}</b>를 치면
            지정자 <b>자동완성</b>이 떠요. 지정자는 코드에서 <b>클래스와 같은 보라색</b>으로
            칠해지고, <b>int32 · FString · TObjectPtr</b> 등 UE 타입·어서션(<b>check ·
            ensure</b>)·델리게이트 선언·Iris 매크로까지 설명합니다.
          </>
        )
      },
      {
        num: '16',
        tag: 'UE 공식 문서 (1.5.5)',
        name: '엔진 주석, 한국어로',
        desc: (
          <>
            <b>AActor · UObject · TObjectPtr · APlayerController</b> 등 핵심 타입 <b>49개의 엔진
            공식 주석 74문단</b>을 전면 번역했어요 — C++ 호버에 실리는 영어 주석이 한국어로
            바뀝니다(설정 ▸ 코드 분석 ▸ C·C++ 행에서 켜고 끔). 엔진 소스로 F12해 들어간
            파일에서도 그대로 동작해요.
          </>
        )
      },
      {
        num: '17',
        tag: '분석 표시 (1.5.5)',
        name: '분석 중을, 정직하게',
        desc: (
          <>
            clangd의 <b>인덱싱 진행률(%)</b>이 이제 폴더 배지와 파일 칩에 보이고, 캐시 색이
            먼저 칠해져도 서버가 준비될 때까지 <b>심볼 분석 중</b> 칩이 유지돼요 — 칩이 사라지는
            순간부터 호버가 됩니다. 콜드 파싱 중 호버가 타임아웃으로 조용히 죽던 것도
            고쳤습니다.
          </>
        )
      },
      {
        num: '18',
        tag: '첨부 (1.5.6)',
        name: '이미지 말고, 파일도',
        desc: (
          <>
            <b>txt · md · html · 코드 · 로그 · json/csv</b> 같은 텍스트 파일을 이미지처럼
            첨부할 수 있어요 — 클립 버튼, 드래그, 파일 붙여넣기 전부요. 첨부는{' '}
            <b>파일 아이콘 칩</b>으로 표시되고, 보낸 말풍선의 칩을 누르면 <b>코드 뷰어</b>로
            바로 열립니다. Claude는 경로를 받아 Read로 그대로 읽어요.
          </>
        )
      },
      {
        num: '19',
        tag: '사용량 (1.5.6)',
        name: '얼마나 남았는지, 바로',
        desc: (
          <>
            구독 한도가 <b>"63% 남음"</b>처럼 잔여분으로 읽히고, claude.ai의{' '}
            <b>추가 사용 크레딧</b>(잔액·월 한도·소진 상태)이 컨텍스트 팝오버와 멀티 헤더에
            떠요. 실행이 끝나거나 팝오버를 여는 순간 <b>즉시 새로 고쳐</b> 방금 쓴 만큼이
            바로 반영됩니다.
          </>
        )
      },
      {
        num: '20',
        tag: '다듬기 (1.5.6)',
        name: '작은 결, 고르게',
        desc: (
          <>
            첨부·이미지에 올리면 윈도우 기본 말풍선 대신 <b>앱 툴팁</b>이 뜨고, 긴 할 일은
            잘리는 대신 <b>줄바꿈으로 전부</b> 보여요. 할 일이 없을 때 "계획 수립 중"이라
            추측하던 문구도 <b>없음</b>으로 정직해졌습니다.
          </>
        )
      }
    ]
  },
  '1.4': {
    title: "WHAT'S NEW",
    lead: 'Verse 공식 문서가 한국어로 다시 태어나고, 과금은 구독과 API 사이를 오가요 — 1.4.',
    notes: [
      {
        num: '01',
        tag: 'Verse · 한국어 문서',
        name: '공식 문서를, 처음부터 다시',
        desc: (
          <>
            <b>/Verse.org</b> · <b>/UnrealEngine.com</b> · <b>/Fortnite.com</b>의 API 주석{' '}
            <b>3,193개를 전면 재번역</b>했어요 — 직역투를 걷어내고 자연스러운 문단으로,
            전문용어엔 <b>짧은 풀이</b>를 붙여서. 호버 카드 서식도 새로: 주석 속 코드 예시는{' '}
            <b>색칠된 코드 블록</b>으로, 긴 문서는 <b>섹션 제목</b>으로, 핵심 용어는{' '}
            <b>코드 색 + 설명 툴팁</b>으로 읽혀요.
          </>
        )
      },
      {
        num: '02',
        tag: 'Verse · 정확도',
        name: '호버가 닿지 않던 곳까지',
        desc: (
          <>
            digest의 <b>파라미터형 타입</b>(<b>chat_channel</b> 같은)이 이제 선언 호버 · 멤버
            자동완성 · 색칠에 모두 잡혀요. <b>transform:</b> 블록형 생성의 타입도 구조체색으로.
            속성 이름과 겹치는 변수의 엉뚱한 호버, 스코프 밖 후보 누출, <b>Foo().</b> 뒤의
            노이즈까지 — 조용히 틀리던 것들을 정리했습니다.
          </>
        )
      },
      {
        num: '03',
        tag: 'Verse · 반응속도',
        name: '열자마자, 바로',
        desc: (
          <>
            .verse 파일을 여는 <b>즉시</b> — 분석 서버가 데워지기 전에도 키워드·지역변수·선언
            호버와 자동완성이 떠요. 파일 저장이나 <b>UEFN Verse 재빌드</b>를 감지하면 완성·색
            데이터가 <b>자동 갱신</b>되어 앱을 껐다 켤 필요가 없고, 분석이 멈춰도 스스로
            복구합니다.
          </>
        )
      },
      {
        num: '04',
        tag: '채팅 · /ask',
        name: '/ask는 기다리지 않아요',
        desc: (
          <>
            AI가 작업 중이어도 <b>/ask는 즉시</b> 열리고, <b>/ 명령 팔레트</b>도 실행 중에
            그대로 떠요. /ask 모달엔 <b>자체 모델·강도·모드</b> 선택이 생겨 — 본 작업은 Fable로,
            빠른 질문은 가볍게. 예약 메시지가 명령 뒤에 갇혀 안 나가던 문제도 고쳤습니다.
          </>
        )
      },
      {
        num: '05',
        tag: '모델',
        name: '전환은, 투명하게',
        desc: (
          <>
            Fable이 <b>Opus로 전환되는 순간</b>(정책 거부 · 한도 · 일시 과부하) 채팅에{' '}
            <b>경고 배너</b>가 뜨고 모델 선택도 따라 바뀌어요. Claude Code가 보내는 알림·경고
            줄도 스레드에 그대로 보이고, 사용량 카드엔 <b>Fable 주간 한도</b>가 추가됐습니다.
          </>
        )
      },
      {
        num: '06',
        tag: '과금 · API 모드 (1.4.1)',
        name: '구독으로도, API 키로도',
        desc: (
          <>
            컴포저의 <b>과금 선택</b>으로 실행마다 <b>구독(정액) ↔ API 키(종량)</b>를 골라요 —
            채팅·코드·/ask는 전역으로, <b>멀티는 패널마다 따로</b>. 키는 설정 → <b>API</b>에{' '}
            <b>Windows 암호화(DPAPI)</b>로 저장되고 화면엔 끝 4자리만, 실행이 실제로 어느 쪽
            인증으로 붙었는지 어긋나면 <b>배너로 알려</b>줍니다.
          </>
        )
      },
      {
        num: '07',
        tag: '과금 · 비용 추적 (1.4.1)',
        name: '쓴 만큼, 보이게',
        desc: (
          <>
            API 모드의 컨텍스트 카드는 한도 대신 <b>이번 대화 비용</b>과 <b>남은 예산</b>(예산
            입력 시)을 보여줘요. 설정 → API의 <b>사용 통계</b>에선 <b>1일·7일·30일·전체</b>{' '}
            기간으로 <b>모델별 비용</b>과 <b>일별 미니 차트</b>, 입력·출력 토큰까지 — 실행 한
            건 한 건이 원장에 쌓입니다.
          </>
        )
      },
      {
        num: '08',
        tag: '설정 · Verse (1.4.1)',
        name: 'Verse 행, 반듯하게',
        desc: (
          <>
            설정 → Code의 <b>Verse 행이 다른 서버와 같은 높이</b>로 정돈됐어요. verse-lsp 연결
            안내와 <b>지정된 경로</b>, 공식 문서 한국어 토글은 <b>행을 펼치면</b> 깔끔하게
            이어집니다.
          </>
        )
      },
      {
        num: '09',
        tag: '멀티 · 승인/질문 (1.4.2)',
        name: '물어본 패널에서, 바로',
        desc: (
          <>
            멀티의 <b>승인·질문 카드가 요청한 패널 안에</b> 떠요 — 여러 패널이 동시에 물어봐도
            어느 작업의 요청인지 위치로 바로 읽히고, 카드가 뜬 패널은 <b>응답 대기</b> 골드
            펄스로 표시됩니다. 숫자 키·Esc는 <b>포커스된 패널의 카드에만</b> 들어가 키 한 번이
            다른 패널의 요청까지 답해버리는 일이 없고, 질문 카드는 <b>크게 보기</b>로 패널
            확장과 이어져요.
          </>
        )
      }
    ]
  },
  '1.3': {
    title: "WHAT'S NEW",
    lead: 'Verse가 색을 넘어 정의로 뛰고, 멤버까지 자동완성. 코드 모드는 넓게, 자동완성은 깔끔하게 — 1.3.',
    notes: [
      {
        num: '01',
        tag: 'Verse · LSP',
        name: 'Verse가, 진짜 언어처럼',
        desc: (
          <>
            색만 입던 <b>.verse</b>가 이제 진짜 언어처럼 읽혀요. <b>정의 이동(F12)</b>·구조화 호버 카드·심볼
            목록에, 함수·타입·멤버·지역/매개변수를 <b>의미대로 색칠</b>하고, <b>멤버 자동완성</b>(타입 ·
            <b>@속성</b> · <b>&lt;지정자&gt;</b>)까지. 아직 저장하지 않은 버퍼에서도 호버와 정의가 떠요.
          </>
        )
      },
      {
        num: '02',
        tag: '자동완성',
        name: '고를 것만, 또렷하게',
        desc: (
          <>
            자동완성 항목마다 <b>종류별 SVG 아이콘과 색 그룹</b>이 붙었어요. 이름이 같은 오버로드는 한 줄로
            합쳐 <b>+N</b>으로 보여 주고, 입력한 접두어와 <b>정확히 맞는 후보</b>만 남겨 — 군더더기 없이
            고릅니다.
          </>
        )
      },
      {
        num: '03',
        tag: '탐색기',
        name: '파일이, 한눈에',
        desc: (
          <>
            탐색기의 글자 배지를 <b>Material 아이콘 테마</b>의 모던 SVG 아이콘으로 바꿨어요. 언어·설정·이미지
            파일이 <b>색과 모양</b>으로 즉시 구분돼, 트리만 훑어도 무엇이 무엇인지 보입니다.
          </>
        )
      },
      {
        num: '04',
        tag: '코드 · 채팅',
        name: '모드에, 꼭 맞게',
        desc: (
          <>
            <b>‘에이전트’ 탭이 ‘코드’</b>가 되고, 우측 패널이 사라진 자리의 할 일·변경 파일·컨텍스트는
            컴포저 위 <b>작업 바</b>로 옮겨 대화 칼럼이 넓어졌어요. 폴더 없는 순수 채팅엔 설명·브레인스토밍 같은
            <b>대화 중심 추천</b>을, 다크모드 Claude 아바타엔 <b>코랄 브랜드색</b>을 되살렸습니다.
          </>
        )
      },
      {
        num: '05',
        tag: 'Verse · 한국어',
        name: '공식 문서를, 한국어로',
        desc: (
          <>
            <b>/Verse.org</b> · <b>/UnrealEngine.com</b> · <b>/Fortnite.com</b> API 주석 설명을 호버에서{' '}
            <b>한국어로</b> 보여줘요(설정에서 원문↔한국어 전환). 선언 위치에서도 — 네이티브·확장 메서드,{' '}
            <b>@editable</b> 같은 속성까지 호버 카드가 뜨고, 속성은 지정자와 갈라 <b>ATTRIBUTES</b> 행으로
            또렷하게 보여요.
          </>
        )
      }
    ]
  },
  '1.2': {
    title: "WHAT'S NEW",
    lead: '여러 에이전트가 나란히 일하는 곳에 파일 탐색기가 들어왔어요. 읽기는 더 또렷하게 — 1.2.',
    notes: [
      {
        num: '01',
        tag: '멀티 · 탐색기',
        name: '패널마다, 파일 트리를',
        desc: (
          <>
            멀티 모드에서 각 패널의 <b>폴더 칩을 누르면</b> 그 자리에서 파일 트리가 펼쳐져요. 패널마다
            작업 폴더가 달라도 — 이름으로 검색하고, AI가 만지거나 새로 만든 파일은 <b>색·배지</b>로,
            클릭하면 그대로 <b>코드 뷰어</b>로 열립니다. 단일 모드의 탐색기를 칩에서 펼치는 형태예요.
          </>
        )
      },
      {
        num: '02',
        tag: '코드 뷰어',
        name: '읽기와 변경을, 따로',
        desc: (
          <>
            코드 뷰어에 <b>변경/일반 보기 토글(Ctrl+D)</b>이 생겼어요. diff 마킹(추가는 초록 행·삭제는
            빨간 줄)을 읽기 모드와 <b>분리</b>해서, 그냥 읽고 싶을 땐 군더더기 없이 — 변경점을 보고 싶을
            땐 한 키로 켜고 끕니다.
          </>
        )
      },
      {
        num: '03',
        tag: 'Verse',
        name: '.verse도, 색을 입고',
        desc: (
          <>
            언리얼 <b>.verse</b> 파일을 인식해요. 전용 아이콘 배지와 <b>구문 강조</b>(UE6 코퍼스 기반),
            설정의 Code 탭에도 노출 — Verse 코드도 다른 언어처럼 또렷하게 읽힙니다.
          </>
        )
      },
      {
        num: '04',
        tag: '채팅',
        name: '읽기 편하게, 더',
        desc: (
          <>
            채팅에서 <b>Ctrl+휠</b>로 글자 크기를 키우고, 본문 폭을 넓혀 긴 답변도 시원하게 봐요. 폴더를
            안 골라도 <b>바탕화면</b>에서 바로 동작해, 가벼운 작업은 폴더 고르는 단계 없이 시작됩니다.
          </>
        )
      }
    ]
  },
  '1.1': {
    title: "WHAT'S NEW",
    lead: '코딩 에이전트 데스크탑이 한 걸음 더 나아갔어요. 읽고, 고치고, 가볍게 대화까지 — 1.1.',
    notes: [
      {
        num: '01',
        tag: '코드 에디터',
        name: '읽고, 이제 고칩니다',
        desc: (
          <>
            코드 뷰어에 <b>CodeMirror 편집기</b>가 들어왔어요. 읽기 모드에선 부모 커밋과의 표준
            diff(추가는 초록 행·삭제는 빨간 고스트 줄)를, 편집 모드에선 군더더기 없는 에디터를 —
            헤더 토글로 오가며 제자리에서 고치고, 검색 바로 파일 안을 바로 훑어요.
          </>
        )
      },
      {
        num: '02',
        tag: '심볼 분석',
        name: '다시 켜도, 거의 즉시',
        desc: (
          <>
            시맨틱 토큰을 프로젝트별로 <b>디스크에 캐시</b>하고 LSP 서버를 미리 데워 둬서, 앱을 다시
            열어도 분석이 곧장 떠요. <b>파일별 진행 칩</b>으로 어디까지 분석됐는지 한눈에 — UE 컴파일
            DB와 clangd 인덱스도 앱 홈으로 깔끔히 옮겼습니다.
          </>
        )
      },
      {
        num: '03',
        tag: 'C# · Roslyn',
        name: '정의도, 호버도 더 정확히',
        desc: (
          <>
            C# 분석 엔진을 <b>Microsoft Roslyn LSP</b>로 교체했어요(.NET 10). 프로젝트 초기화가 끝날
            때까지 기다렸다 칠해 호버가 들쭉날쭉하지 않고, <b>정의 이동·타입 정보</b>가 한결
            정확해졌습니다.
          </>
        )
      },
      {
        num: '04',
        tag: '창 · 입력',
        name: '작은 마찰까지',
        desc: (
          <>
            최대화 버튼에서 펼쳐지는 <b>커스텀 창 스냅</b>(반·1/4 배치), 반응형 컴포저, 다듬은 검색
            바, 질문 모달 위치 정리까지 — 손에 닿는 자리들을 매만졌어요.
          </>
        )
      },
      {
        num: '05',
        tag: '채팅',
        name: '탐색기 없이, 그냥 대화',
        desc: (
          <>
            맨 앞에 <b>채팅</b> 탭이 생겼어요. 탐색기도 작업 폴더 선택도 없이 바로 — 자체 대화
            목록을 가진 순수 대화 공간이에요. 작업 모드는 <b>채팅 · 에이전트 · 멀티</b>로 정리하고,
            탭과 새 대화 버튼에 호버 설명을 더했습니다.
          </>
        )
      }
    ]
  }
}

// 가장 높은 시리즈를 폴백으로 — 미래 버전이 RELEASES에 아직 없으면 최신 덱을 보여 준다
function pickRelease(version: string): Release {
  const exact = RELEASES[seriesOf(version)]
  if (exact) return exact
  const latest = Object.keys(RELEASES).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  )
  return RELEASES[latest[latest.length - 1]]
}

// 한 줄 리드 문장을 글자 단위로 — 마운트하면 왼→오로 또렷해진다 (레퍼런스의 AnimatedText)
function CharReveal({ text }: { text: string }): ReactNode {
  return (
    <>
      {Array.from(text).map((ch, i) => (
        <span key={i} className="un-char" style={{ animationDelay: `${0.25 + i * 0.014}s` }}>
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </>
  )
}

export function UpdateNotes(): ReactNode {
  const [version, setVersion] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 도장이 "있고"(설치 이력 있음) 시리즈가 바뀐 업데이트에서만 — 첫 설치는 WhatsNew가,
  // 같은 시리즈의 패치(1.1.1 등)는 이미 본 내용이라 스킵.
  useEffect(() => {
    window.api.app
      .getVersion()
      .then((v) => {
        if (!v) return
        const seen = getPref<string>(SEEN_KEY, '')
        if (!seen) return // 첫 설치 → WhatsNew가 맡는다
        if (seriesOf(seen) === seriesOf(v)) return // 같은 마이너 시리즈 → 이미 봄
        setVersion(v)
      })
      .catch(() => {})
  }, [])

  const close = (): void => {
    if (version) setPref(SEEN_KEY, version)
    setVersion(null)
  }

  useEffect(() => {
    if (!version) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [version])

  // 넘버드 리스트가 뷰포트로 들어오는 순간 한 줄씩 떠오른다 (레퍼런스의 스크롤 FadeIn)
  useEffect(() => {
    if (!version) return
    const root = listRef.current
    if (!root) return
    const items = Array.from(root.querySelectorAll<HTMLElement>('.un-item'))
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        }
      },
      { threshold: 0.18 }
    )
    items.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [version])

  if (!version) return null

  const rel = pickRelease(version)

  return (
    <div className="set-dialog-overlay un-overlay" role="dialog" aria-modal="true">
      {/* 상단 내비 — 로고 + 버전 (닫기는 하단 CTA·Esc로) */}
      <header className="un-nav">
        <div className="un-logo">
          Agent Code GUI<sup>v{version}</sup>
        </div>
      </header>

      {/* 히어로 — 메탈 그라데이션 대제목 + 글자 단위로 떠오르는 한 줄 */}
      <section className="un-hero">
        <div className="un-eyebrow">새 버전 · v{version}</div>
        <h1 className="un-title">{rel.title}</h1>
        <p className="un-lead">
          <CharReveal text={rel.lead} />
        </p>
        <div className="un-scrollhint" aria-hidden="true">
          아래로 스크롤
        </div>
      </section>

      {/* 키워드 마퀴 — 레퍼런스의 스크롤 마퀴를 외부 에셋 없이 텍스트로. 화면보다 넓게
          채운 한 그룹을 둘로 복제하고 정확히 한 그룹 폭(-50%)만큼 굴려서, 두 번째 그룹이
          첫 그룹 자리로 들어와 끊김 없이 계속 도는 무한 루프가 된다 */}
      <div className="un-marquee" aria-hidden="true">
        <div className="un-marquee-track">
          {Array.from({ length: 2 }).map((_, half) => (
            <div className="un-marquee-group" key={half}>
              {Array.from({ length: 3 }).flatMap((_, rep) =>
                rel.notes.map((n) => (
                  <span key={`${half}-${rep}-${n.num}`} className="un-marquee-item">
                    {n.tag} <em>·</em>
                  </span>
                ))
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 변경점 — 01·02·03 넘버드 리스트 (포트폴리오 서비스 섹션) */}
      <section className="un-list" ref={listRef}>
        {rel.notes.map((n) => (
          <article key={n.num} className="un-item">
            <div className="un-num">{n.num}</div>
            <div className="un-body">
              <div className="un-tag">{n.tag}</div>
              <h2 className="un-name">{n.name}</h2>
              <p className="un-desc">{n.desc}</p>
            </div>
          </article>
        ))}
      </section>

      {/* 마무리 CTA — 레퍼런스 ContactButton(그라데이션 필) */}
      <footer className="un-foot">
        <button className="un-cta" onClick={close}>
          시작하기
        </button>
      </footer>
    </div>
  )
}

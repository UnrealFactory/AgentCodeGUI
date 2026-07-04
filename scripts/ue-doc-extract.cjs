/* UE 공식 주석 추출기 — 언리얼 엔진 소스에서 핵심 타입의 클래스 주석(/** … *\/)을 뽑아
 * 문단 단위로 정규화·해시(sha1 12자리)해 JSON으로 떨군다. 이 해시가 번역 팩
 * (src/main/lsp/ue-doc-ko.json)의 키다 — 런타임(ueDocKo.ts)은 clangd 호버의 문단을 같은
 * 방식으로 정규화·해시해 번역을 찾는다(공백/줄바꿈 차이에 안전).
 *
 *   node scripts/ue-doc-extract.cjs ["C:\\Program Files\\Epic Games\\UE_5.8"]
 *   → scripts/ue-doc-extracted.json  ({ symbol, file, paragraphs: [{ key, en }] }[])
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const UE = process.argv[2] || 'C:\\Program Files\\Epic Games\\UE_5.8'
const SRC = path.join(UE, 'Engine', 'Source', 'Runtime')

// 심볼 → 선언이 있는 헤더(Runtime 기준 상대 경로). FVector 류는 UE5에서 TVector<T> 템플릿의
// 별칭이므로 템플릿 쪽 주석을 추출한다(호버에 그 주석이 실린다).
const TARGETS = [
  // Core
  // TMap·TSet·FString·FText — UE 5.8에서 선언이 재구성돼 텍스트 형태의 클래스 정의/주석이
  // Core/Public에 없다. 팩에서 제외(호버는 영어 원문 유지, 우리 폴백 카드가 한국어 한 줄 담당).
  ['TArray', 'Core/Public/Containers/Array.h'],
  ['FName', 'Core/Public/UObject/NameTypes.h'],
  ['TVector', 'Core/Public/Math/Vector.h'],
  ['TVector2', 'Core/Public/Math/Vector2D.h'],
  ['TRotator', 'Core/Public/Math/Rotator.h'],
  ['TQuat', 'Core/Public/Math/Quat.h'],
  ['FColor', 'Core/Public/Math/Color.h'],
  ['FLinearColor', 'Core/Public/Math/Color.h'],
  ['TSharedPtr', 'Core/Public/Templates/SharedPointer.h'],
  ['TSharedRef', 'Core/Public/Templates/SharedPointer.h'],
  ['TUniquePtr', 'Core/Public/Templates/UniquePtr.h'],
  // CoreUObject
  ['UObject', 'CoreUObject/Public/UObject/Object.h'],
  ['TObjectPtr', 'CoreUObject/Public/UObject/ObjectPtr.h'],
  ['TWeakObjectPtr', 'Core/Public/UObject/WeakObjectPtrTemplates.h'],
  ['TSoftObjectPtr', 'CoreUObject/Public/UObject/SoftObjectPtr.h'],
  ['TSubclassOf', 'CoreUObject/Public/Templates/SubclassOf.h'],
  ['FObjectInitializer', 'CoreUObject/Public/UObject/UObjectGlobals.h'],
  ['FLifetimeProperty', 'CoreUObject/Public/UObject/CoreNet.h'],
  // Engine
  ['AActor', 'Engine/Classes/GameFramework/Actor.h'],
  ['APawn', 'Engine/Classes/GameFramework/Pawn.h'],
  ['ACharacter', 'Engine/Classes/GameFramework/Character.h'],
  ['AController', 'Engine/Classes/GameFramework/Controller.h'],
  ['APlayerController', 'Engine/Classes/GameFramework/PlayerController.h'],
  ['AGameModeBase', 'Engine/Classes/GameFramework/GameModeBase.h'],
  ['AGameStateBase', 'Engine/Classes/GameFramework/GameStateBase.h'],
  ['APlayerState', 'Engine/Classes/GameFramework/PlayerState.h'],
  ['UGameInstance', 'Engine/Classes/Engine/GameInstance.h'],
  ['UWorld', 'Engine/Classes/Engine/World.h'],
  ['UActorComponent', 'Engine/Classes/Components/ActorComponent.h'],
  ['USceneComponent', 'Engine/Classes/Components/SceneComponent.h'],
  ['UPrimitiveComponent', 'Engine/Classes/Components/PrimitiveComponent.h'],
  ['UStaticMeshComponent', 'Engine/Classes/Components/StaticMeshComponent.h'],
  ['USkeletalMeshComponent', 'Engine/Classes/Components/SkeletalMeshComponent.h'],
  ['UCharacterMovementComponent', 'Engine/Classes/GameFramework/CharacterMovementComponent.h'],
  ['UCameraComponent', 'Engine/Classes/Camera/CameraComponent.h'],
  ['USpringArmComponent', 'Engine/Classes/GameFramework/SpringArmComponent.h'],
  ['UBoxComponent', 'Engine/Classes/Components/BoxComponent.h'],
  ['USphereComponent', 'Engine/Classes/Components/SphereComponent.h'],
  ['UCapsuleComponent', 'Engine/Classes/Components/CapsuleComponent.h'],
  ['UInputComponent', 'Engine/Classes/Components/InputComponent.h'],
  ['FHitResult', 'Engine/Classes/Engine/HitResult.h'],
  ['FTimerHandle', 'Engine/Classes/Engine/TimerHandle.h'],
  // AIModule / UMG
  ['AAIController', 'AIModule/Classes/AIController.h'],
  ['UUserWidget', 'UMG/Public/Blueprint/UserWidget.h'],
  // Enhanced Input (플러그인 — 'Plugins/' 접두 경로는 Engine/Plugins 기준으로 푼다)
  ['UInputAction', 'Plugins/EnhancedInput/Source/EnhancedInput/Public/InputAction.h'],
  ['UInputMappingContext', 'Plugins/EnhancedInput/Source/EnhancedInput/Public/InputMappingContext.h'],
  ['UEnhancedInputComponent', 'Plugins/EnhancedInput/Source/EnhancedInput/Public/EnhancedInputComponent.h'],
  ['FInputActionValue', 'Plugins/EnhancedInput/Source/EnhancedInput/Public/InputActionValue.h'],
  ['UEnhancedInputLocalPlayerSubsystem', 'Plugins/EnhancedInput/Source/EnhancedInput/Public/EnhancedInputSubsystems.h']
]

// clangd 호버와 같은 눈높이의 정규화 — 공백/줄바꿈을 전부 한 칸으로
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const keyOf = (s) => crypto.createHash('sha1').update(norm(s)).digest('hex').slice(0, 12)

// /** … */ 블록 하나의 원문 → 문단 배열
function blockParagraphs(raw) {
  const body = raw
    .replace(/^\s*\/\*\*?/, '')
    .replace(/\*\/\s*$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').replace(/\s+$/, ''))
    .join('\n')
    .trim()
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^[-=*~\s]+$/.test(p)) // 구분선-온리 문단 제외 (~==== 스타일 포함)
}

// 선언 줄(정방향 첫 매치) 위로 걸어 올라가 붙은 주석을 찾는다.
// · 사이의 UCLASS(...) 매크로(여러 줄 가능)·template<...>·namespace·'{'·빈 줄은 건너뛴다
// · /** … */ 블록과 연속 `//` 줄 묶음을 모두 지원하고, 붙어 있는 블록 여러 개도 전부 모은다
//   (clangd가 어느 쪽을 호버에 싣든 문단 해시가 맞아떨어지게)
function extract(lines, declRe) {
  const di = lines.findIndex((l) => declRe.test(l))
  if (di < 0) return { error: 'decl not found' }
  let i = di - 1
  let parenDepth = 0
  while (i >= 0) {
    const t = lines[i].trim()
    if (!t) {
      i--
      continue
    }
    // UCLASS(...)/USTRUCT(...) — 닫는 괄호부터 여는 괄호까지 거슬러 올라간다
    if (parenDepth > 0 || /\)\s*$/.test(t)) {
      parenDepth += (t.match(/\)/g) || []).length - (t.match(/\(/g) || []).length
      if (parenDepth <= 0 && /^(UCLASS|USTRUCT|UENUM|UINTERFACE)\b/.test(t)) parenDepth = 0
      i--
      continue
    }
    if (
      /^(UCLASS|USTRUCT|UENUM|UINTERFACE)\b/.test(t) ||
      /^template\b/.test(t) ||
      /^#/.test(t) ||
      /^namespace\b/.test(t) ||
      t === '{'
    ) {
      i--
      continue
    }
    break
  }
  // 주석 블록들을 아래→위로 수집 (사이 빈 줄 1줄까지 허용)
  const paragraphs = []
  let blanks = 0
  while (i >= 0) {
    const t = lines[i].trim()
    if (!t) {
      if (++blanks > 1) break
      i--
      continue
    }
    blanks = 0
    if (/\*\/\s*$/.test(t)) {
      const end = i
      while (i >= 0 && !lines[i].includes('/*')) i--
      if (i < 0) break
      paragraphs.unshift(...blockParagraphs(lines.slice(i, end + 1).join('\n')))
      i--
      continue
    }
    if (t.startsWith('//')) {
      const end = i
      while (i >= 0 && lines[i].trim().startsWith('//')) i--
      // 연속 // 줄 묶음은 하나의 블록 — clangd도 한 문단으로 싣는다
      const run = lines
        .slice(i + 1, end + 1)
        .map((l) => l.replace(/^\s*\/\/+\s?/, '').replace(/\s+$/, ''))
        .join('\n')
        .trim()
      if (run && !/^[-=*~\s]+$/.test(run)) paragraphs.unshift(run)
      continue
    }
    break
  }
  if (!paragraphs.length) return { error: 'no doc comment' }
  return { paragraphs }
}

const out = []
const seen = new Set()
for (const [symbol, rel] of TARGETS) {
  // 'Plugins/…' 는 Engine/Plugins(플러그인 트리), 그 외는 Engine/Source/Runtime 기준
  const file = rel.startsWith('Plugins/') ? path.join(UE, 'Engine', rel) : path.join(SRC, rel)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    out.push({ symbol, file: rel, error: 'file not found' })
    continue
  }
  const lines = text.split(/\r?\n/)
  // alignas(16)·API 매크로가 이름 앞에 낄 수 있다 (TQuat: `struct alignas(16) TQuat`)
  const declRe = new RegExp(`^\\s*(?:class|struct)\\s+(?:alignas\\(\\d+\\)\\s+)?(?:[A-Z_]+_API\\s+)?${symbol}\\b[^;]*$`)
  const r = extract(lines, declRe)
  if (r.error) {
    out.push({ symbol, file: rel, error: r.error })
    continue
  }
  const paragraphs = []
  for (const p of r.paragraphs) {
    const key = keyOf(p)
    if (seen.has(key)) continue
    seen.add(key)
    paragraphs.push({ key, en: norm(p) })
  }
  out.push({ symbol, file: rel, paragraphs })
}

const dest = path.join(__dirname, 'ue-doc-extracted.json')
fs.writeFileSync(dest, JSON.stringify(out, null, 2))
const ok = out.filter((o) => !o.error).length
console.log(`추출 완료: ${ok}/${TARGETS.length} 심볼 → ${dest}`)
for (const o of out) if (o.error) console.log('  누락:', o.symbol, '—', o.error, `(${o.file})`)

// Installs the self-contained adapter example on the user's Desktop.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const root=path.resolve(import.meta.dirname,'..')
const desktop=execFileSync('powershell.exe',['-NoProfile','-Command',"[Environment]::GetFolderPath('Desktop')"],{encoding:'utf8',windowsHide:true}).trim()
const destination=path.join(desktop,'AgentCodeGUI 외부 도구 테스트')
fs.mkdirSync(destination,{recursive:true})
for(const name of ['client.mjs','server.mjs','index.html'])fs.copyFileSync(path.join(root,'examples','external-tool-lab',name),path.join(destination,name))
const appHome=process.argv.find(a=>a.startsWith('--app-home='))?.slice('--app-home='.length)
const quote=s=>'"'+s.replaceAll('"','""')+'"'
const command=[quote(process.execPath),quote(path.join(destination,'server.mjs')),'--open',...(appHome?[quote('--app-home='+path.resolve(appHome))]:[])].join(' ')
const script='Set shell = CreateObject("WScript.Shell")\r\nshell.Run "'+command.replaceAll('"','""')+'", 0, False\r\n'
fs.writeFileSync(path.join(destination,'테스트 도구 실행.vbs'),Buffer.from('\ufeff'+script,'utf16le'))
const previewCommand=[quote(process.execPath),quote(path.join(root,'scripts','open-external-tools-preview.mjs')),quote('--tool-dir='+destination)].join(' ')
const previewScript='Set shell = CreateObject("WScript.Shell")\r\nshell.Run "'+previewCommand.replaceAll('"','""')+'", 0, False\r\n'
fs.writeFileSync(path.join(destination,'검증 앱과 함께 실행.vbs'),Buffer.from('\ufeff'+previewScript,'utf16le'))
fs.writeFileSync(path.join(destination,'사용 방법.txt'),[
  'AgentCodeGUI 외부 도구 연결 테스트','',
  '1. 외부 도구 연결 기능이 포함된 AgentCodeGUI를 실행합니다.',
  '2. 테스트 도구 실행.vbs를 더블클릭합니다.',
  '3. AgentCodeGUI의 원하는 세션에서 [도구 연결]을 열고 CodePad Test 등을 연결합니다.',
  '4. 테스트 도구에서 코드를 드래그하거나 표의 행을 선택합니다.',
  '5. 각 도구를 켜고 끄면서 선택 내용과 상태가 해당 세션에만 전달되는지 확인합니다.',
  '6. 테스트가 끝나면 테스트 도구 상단의 [테스트 도구 종료]를 누릅니다.','',
  'Node.js가 필요합니다. 프로그램은 로컬 PC에서만 연결하며 AI를 자동으로 실행하지 않습니다.',
  appHome?'앱 데이터 경로: '+path.resolve(appHome):'앱 데이터 경로: 기본 AgentCodeGUI 프로필',
  '원본 예제: '+path.join(root,'examples','external-tool-lab'),
  '','[바로 확인하기] 검증 앱과 함께 실행.vbs',
  '실제 새 앱 빌드와 테스트 도구를 별도 프로필로 함께 실행합니다.',
  'AI 답변은 고정된 검증용 응답입니다. 기존 앱 계정과 대화는 사용하지 않습니다.',
  '검증 앱 실행에는 위 원본 저장소와 target/debug 빌드가 필요합니다.'
].join('\r\n'),'utf8')
console.log(destination)

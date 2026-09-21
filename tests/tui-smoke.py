"""Exercise the real Pi terminal. Key handling exists only in this test driver."""
import fcntl, json, os, pty, re, select, shutil, struct, subprocess, sys, tempfile, termios, time
options=json.loads(sys.argv[1])
root=tempfile.mkdtemp(prefix='provider-pty-')
for name in ['home','agent','cwd']: os.mkdir(os.path.join(root,name))
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',65,140,0,0))
env={'PATH':os.environ['PATH'],'HOME':root+'/home','PI_CODING_AGENT_DIR':root+'/agent','PI_OFFLINE':'1','LANG':'en_US.UTF-8','TERM':'xterm-256color'}
args=[options['node'],options['cli'],'--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-tools','--provider-catalog-url','off','-e',options['repo']+'/src/index.ts']
process=subprocess.Popen(args,cwd=root+'/cwd',env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
output=''
ansi=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')
def wait(label):
 global output
 until=time.monotonic()+15
 while time.monotonic()<until:
  if label in ansi.sub('',output): return
  if process.poll() is not None: raise AssertionError('Pi exited: '+output[-4000:])
  if select.select([master],[],[],.1)[0]:
   data=os.read(master,262144)
   if b'\x1b[6n' in data: os.write(master,b'\x1b[1;1R')
   output+=data.decode('utf-8',errors='replace')
 raise AssertionError('Missing '+label+'; terminal: '+ansi.sub('',output)[-5000:])
def act(keys,label):
 global output
 output=''
 for key in keys:
  os.write(master,key.encode());time.sleep(.045)
 wait(label)
def pick(index,label): act(['\x1b[B']*index+['\r'],label)
def input(value,label): act([value,'\r'],label)
def config():
 with open(root+'/agent/models.json') as f: return json.load(f)
try:
 wait('pi v')
 act(['/provider-setup','\r'],'供应商管理')
 pick(0,'API 类型')
 pick(options['apiIndex'],'Base URL')
 input('http://127.0.0.1:18080/v1','供应商 ID')
 input('pty-provider','认证方式')
 pick(0,'未保存草稿')
 pick(3,'模型 ID')
 input('pty-model','未保存草稿')
 pick(5,'保存配置')
 pick(0,'供应商管理')
 assert config()['providers']['pty-provider']['models'][0]['id']=='pty-model'
 # Invalid JSON in the native editor leaves the draft unchanged.
 pick(1,'编辑配置与模型')
 pick(0,'未保存草稿')
 pick(4,'模型')
 pick(0,'模型操作')
 pick(0,'模型字段')
 pick(7,'external editor')
 act(list('not-json')+['\r'],'JSON 格式错误')
 wait('未保存草稿')
 pick(6,'供应商管理')
 assert 'cost' not in config()['providers']['pty-provider']['models'][0]
 # Rename through native field selector/input, then explicitly save.
 pick(1,'编辑配置与模型')
 pick(0,'未保存草稿')
 pick(0,'选择字段')
 pick(0,'供应商 ID')
 input('pty-renamed','未保存草稿')
 pick(5,'保存配置')
 pick(0,'供应商管理')
 assert 'pty-provider' not in config()['providers']
 assert 'pty-renamed' in config()['providers']
 # Cancel a draft edit and verify that the file remains unchanged.
 before=config()
 pick(1,'编辑配置与模型')
 pick(0,'未保存草稿')
 pick(0,'选择字段')
 pick(1,'显示名称')
 input('discard-me','未保存草稿')
 pick(6,'供应商管理')
 assert config()==before
 # Native confirmation guards deletion; first decline, then confirm.
 pick(1,'编辑配置与模型')
 pick(3,'已有凭据会保留')
 pick(1,'供应商管理')
 assert 'pty-renamed' in config()['providers']
 pick(1,'编辑配置与模型')
 pick(3,'已有凭据会保留')
 pick(0,'供应商管理')
 assert config()['providers']=={}
 print('Native Pi PTY: create, model edit, save, rename, discard and confirmed deletion passed')
finally:
 process.terminate()
 try: process.wait(timeout=3)
 except subprocess.TimeoutExpired: process.kill();process.wait()
 os.close(master);shutil.rmtree(root)

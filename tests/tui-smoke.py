"""Exercise the real Pi terminal. Key handling exists only in this test driver."""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import fcntl, json, os, pty, re, select, shutil, struct, subprocess, sys, tempfile, termios, time
options=json.loads(sys.argv[1])
requests=[]
class ModelsHandler(BaseHTTPRequestHandler):
 def do_GET(self):
  requests.append(self.path)
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
  self.wfile.write(b'{}' if self.path == '/catalog' else b'{"data": []}')
 def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),ModelsHandler)
threading.Thread(target=server.serve_forever,daemon=True).start()
root=tempfile.mkdtemp(prefix='provider-pty-')
for name in ['home','agent','cwd']: os.mkdir(os.path.join(root,name))
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',65,140,0,0))
env={'PATH':os.environ['PATH'],'HOME':root+'/home','PI_CODING_AGENT_DIR':root+'/agent','PI_OFFLINE':'1','LANG':'en_US.UTF-8','TERM':'xterm-256color'}
args=[options['node'],options['cli'],'--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-tools','--provider-catalog-url',f'http://127.0.0.1:{server.server_port}/catalog','-e',options['repo']+'/src/index.ts']
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
 raise AssertionError('Missing '+label+'; requests: '+repr(requests)+'; terminal: '+ansi.sub('',output)[-5000:])
def act(keys,label):
 global output
 output=''
 for key in keys:
  os.write(master,key.encode());time.sleep(.045)
 wait(label)
 while select.select([master],[],[],.15)[0]:
  data=os.read(master,262144)
  if b'\x1b[6n' in data: os.write(master,b'\x1b[1;1R')
  output+=data.decode('utf-8',errors='replace')
def pick(index,label): act(['\x1b[B']*index+['\r'],label)
def input(value,label): act([value,'\r'],label)
def config():
 with open(root+'/agent/models.json') as f: return json.load(f)
def choose(query,label): act(['\x15',query.replace(' ',''),'\r'],label)
def edit(value,label): act(['\x01','\x0b',value,'\r'],label)
def open_provider(name,has_models=True):
 choose(name,'navigate')
def manual_model():
 choose('Add model','Enter model manually')
 choose('Enter model manually','Model name')
try:
 wait('pi v')
 act(['/model-config','\r'],'Create provider')
 # Create a provider: API type first, then the endpoints Pi knows for it (or a base URL of your own).
 pick(0,'API type')
 pick(options['apiIndex'],'Enter a base URL myself')
 choose('Enter a base URL myself','Base URL')
 input(f'http://127.0.0.1:{server.server_port}/v1','Provider ID')
 input('pty-provider','Authentication method')
 pick(0,'Enter model manually')
 # A new provider discovers immediately; the selection screen is already open.
 choose('Enter model manually','Model name')
 choose('Model ID','Enter to submit')
 edit('cancelled-model','Type to search')
 choose('Cancel','Enter model manually')
 act(['\x1b'],'Provider: pty-provider')
 manual_model()
 choose('Model ID','Enter to submit')
 edit('pty-model','Type to search')
 choose('Model name','Enter to submit')
 edit('PTY model','Type to search')
 choose('Context window','Enter to submit')
 edit('64000','Type to search')
 choose('Add model','Enter model manually')
 act(['\x1b'],'Provider: pty-provider')
 # Closing the selection screen auto-saves.
 assert config()['providers']['pty-provider']['models']==[{'id':'pty-model','name':'PTY model','contextWindow':64000}]
 # We are back on the provider page. No Provider actions submenu exists.
 page=ansi.sub('',output)
 assert 'Provider: pty-provider' in page and 'Models' in page
 assert 'Provider actions' not in page
 choose('Add model','Enter model manually')
 act(['\x1b'],'Provider: pty-provider')
 choose('pty-model','Model: pty-model')
 # The model form groups fields; a boolean row toggles in place.
 choose('Supports reasoning','Supports reasoning')
 choose('Context window','Context window')
 edit('96000','96000')
 # compat only lists configured keys; add one explicitly.
 # The compat field list is rendered by the panel itself, so wait for a value only it shows.
 choose('Add compat field','cacheControlFormat')
 pick(9,'supportsStore'.ljust(24)+'Yes')
 act(['\x1b'],'Provider: pty-provider')
 # Closing the model screen auto-saves.
 model=config()['providers']['pty-provider']['models'][0]
 assert model['contextWindow']==96000 and model['reasoning'] is True
 assert model['compat']=={'supportsStore':True}
 # The provider fields are on the provider page; editing one auto-saves immediately.
 choose('Provider ID','enter submit')
 edit('pty-renamed','Provider: pty-renamed')
 assert 'pty-provider' not in config()['providers']
 assert 'pty-renamed' in config()['providers']
 choose('Add model','Enter model manually')
 choose('pty-model','Remove from provider')
 act(['\r'],'pty-model'.ljust(36)+'No')
 act(['\x1b'],'Provider: pty-renamed')
 # Closing the selection screen auto-saves the empty model list.
 assert config()['providers']['pty-renamed']['models']==[]
 choose('Delete provider','Existing credentials will be retained')
 pick(1,'Provider: pty-renamed')
 assert 'pty-renamed' in config()['providers']
 choose('Delete provider','Existing credentials will be retained')
 pick(0,'Create provider')
 assert config()['providers']=={}
 assert '/v1/models' in requests and '/catalog' in requests
 print('Native Pi PTY: native dialogs, auto-save, complete creation, cancellation, edit, rename and deletion passed')
finally:
 server.shutdown();server.server_close()
 process.terminate()
 try: process.wait(timeout=3)
 except subprocess.TimeoutExpired: process.kill();process.wait()
 os.close(master);shutil.rmtree(root)

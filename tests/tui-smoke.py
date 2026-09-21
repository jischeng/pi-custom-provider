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
 choose('Add model','Back to models')
 choose('Enter model manually','Model name')
try:
 wait('pi v')
 act(['/provider-setup','\r'],'Create provider')
 pick(0,'API type')
 pick(options['apiIndex'],'Base URL')
 input(f'http://127.0.0.1:{server.server_port}/v1','Provider ID')
 input('pty-provider','Authentication method')
 pick(0,'No models added.')
 # Add discovers and opens selection; manual creation is a secondary action.
 manual_model()
 choose('Model ID','external editor')
 edit('cancelled-model','Type to search')
 choose('Cancel','Back to models')
 act(['\x1b'],'No models added.')
 manual_model()
 choose('Model ID','external editor')
 edit('pty-model','Type to search')
 choose('Model name','external editor')
 edit('PTY model','Type to search')
 choose('Context window','external editor')
 edit('64000','Type to search')
 choose('Add model','Back to models')
 choose('Back to models','Actions')
 choose('Save changes','Save configuration')
 pick(0,'Create provider')
 assert config()['providers']['pty-provider']['models']==[{'id':'pty-model','name':'PTY model','contextWindow':64000}]
 open_provider('pty-provider')
 # Models and actions are visible together. No Provider actions submenu exists.
 page=ansi.sub('',output)
 assert 'Provider: pty-provider' in page and 'Models' in page and 'Actions' in page
 assert 'Provider actions' not in page
 # Down crosses directly from the only model into Add model, without Tab.
 act(['\x1b[B','\r'],'Back to models')
 act(['\x1b'],'Actions')
 # Up crosses directly back from Add model to the existing model.
 act(['\x1b[A','\r'],'Model: pty-model')
 choose('Context window','external editor')
 edit('96000','Type to search')
 choose('Context window','external editor')
 wait('96000')
 act(['\x03'],'Type to search')
 choose('Supports reasoning','Yes')
 choose('Compatibility settings','Apply Compatibility settings')
 choose('Advanced JSON','external editor')
 edit('invalid-json','Invalid JSON')
 pick(0,'Advanced JSON')
 act(['\x03'],'Compatibility settings')
 choose('Back to provider','Actions')
 choose('Save changes','Save configuration')
 pick(0,'Create provider')
 model=config()['providers']['pty-provider']['models'][0]
 assert model['contextWindow']==96000 and model['reasoning'] is True
 open_provider('pty-provider')
 choose('Provider settings','Provider ID')
 choose('Provider ID','external editor')
 edit('pty-renamed','Type to search')
 choose('Back to models','Actions')
 choose('Save changes','Save configuration')
 pick(0,'Create provider')
 assert 'pty-provider' not in config()['providers']
 assert 'pty-renamed' in config()['providers']
 before=config()
 open_provider('pty-renamed')
 choose('Provider settings','Provider ID')
 choose('Display name','external editor')
 edit('discard-me','Type to search')
 choose('Back to models','Actions')
 choose('Discard changes','Create provider')
 assert config()==before
 open_provider('pty-renamed')
 choose('Add model','Back to models')
 choose('pty-model','No')
 choose('Back to models','No models added.')
 choose('Save changes','Save configuration')
 pick(0,'Create provider')
 assert config()['providers']['pty-renamed']['models']==[]
 open_provider('pty-renamed',False)
 choose('Delete provider','Existing credentials will be retained')
 pick(1,'No models added.')
 choose('Discard changes','Create provider')
 assert 'pty-renamed' in config()['providers']
 open_provider('pty-renamed',False)
 choose('Delete provider','Existing credentials will be retained')
 pick(0,'Create provider')
 assert config()['providers']=={}
 assert '/v1/models' in requests and '/catalog' in requests
 print('Native Pi PTY: grouped provider window, nested model dialogs, complete creation, cancellation, edit, save, rename, discard and deletion passed')

finally:
 server.shutdown();server.server_close()
 process.terminate()
 try: process.wait(timeout=3)
 except subprocess.TimeoutExpired: process.kill();process.wait()
 os.close(master);shutil.rmtree(root)

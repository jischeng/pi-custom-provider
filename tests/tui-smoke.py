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
def choose(query,label): act(['\x15',query.replace(' ',''),'\r'],label)
def edit(value,label): act(['\x01','\x0b',value,'\r'],label)
try:
 wait('pi v')
 act(['/provider-setup','\r'],'Create provider')
 pick(0,'API type')
 pick(options['apiIndex'],'Base URL')
 input('http://127.0.0.1:18080/v1','Provider ID')
 input('pty-provider','Authentication method')
 pick(0,'Type to search')
 # Settings show existing values; search goes directly to the requested field/action.
 choose('Add model','Model ID')
 input('pty-model','Type to search')
 choose('Save changes','Save configuration')
 pick(0,'Create provider')
 assert config()['providers']['pty-provider']['models'][0]['id']=='pty-model'
 choose('pty-provider','pty-model')
 assert 'Provider ID' not in ansi.sub('',output)
 pick(0,'Context window')
 choose('Context window','external editor')
 edit('96000','Type to search')
 # Reopening the same editor must show the updated value rather than its initial value.
 choose('Context window','external editor')
 wait('96000')
 act(['\x03'],'Type to search')
 choose('Supports reasoning','Yes')
 choose('Compatibility settings','Apply Compatibility settings')
 choose('Advanced JSON','external editor')
 edit('invalid-json','Invalid JSON')
 act(['\x03'],'Compatibility settings')
 choose('Back to provider','Type to search')
 choose('Save changes','Save configuration')
 pick(0,'Create provider')
 model=config()['providers']['pty-provider']['models'][0]
 assert model['contextWindow']==96000 and model['reasoning'] is True
 # Rename with native settings/editor, then save.
 choose('pty-provider','Type to search')
 choose('Provider settings','Provider ID')
 choose('Provider ID','external editor')
 edit('pty-renamed','Type to search')
 choose('Back to models','Type to search')
 choose('Save changes','Save configuration')
 pick(0,'Create provider')
 assert 'pty-provider' not in config()['providers']
 assert 'pty-renamed' in config()['providers']
 before=config()
 choose('pty-renamed','Type to search')
 choose('Provider settings','Provider ID')
 choose('Display name','external editor')
 edit('discard-me','Type to search')
 choose('Back to models','Type to search')
 choose('Discard changes','Create provider')
 assert config()==before
 # Searchable native model selection toggles in place and remains unsaved until explicit save.
 choose('pty-renamed','Type to search')
 choose('Select models','Apply selection')
 choose('pty-model','No')
 choose('Apply selection','Type to search')
 choose('Save changes','Save configuration')
 pick(0,'Create provider')
 assert config()['providers']['pty-renamed']['models']==[]
 choose('pty-renamed','Type to search')
 choose('Delete provider','Existing credentials will be retained')
 pick(1,'Type to search')
 choose('Discard changes','Create provider')
 assert 'pty-renamed' in config()['providers']
 choose('pty-renamed','Type to search')
 choose('Delete provider','Existing credentials will be retained')
 pick(0,'Create provider')
 assert config()['providers']=={}
 print('Native Pi PTY: searchable settings, prefilled editor, inline toggles, model selection, save, rename, discard and deletion passed')

finally:
 process.terminate()
 try: process.wait(timeout=3)
 except subprocess.TimeoutExpired: process.kill();process.wait()
 os.close(master);shutil.rmtree(root)

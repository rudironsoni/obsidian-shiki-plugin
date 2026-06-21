# PyCharm Django Console fixes

```python showLineNumbers
import builtins, os, runpy, sys
USER_print('Python %s on %s' % (sys.version, sys.platform))
import django
print('Django %s' % django.get_version())
sys.path.extend(['/app/src', '/opt/.pycharm_helpers/pycharm', '/opt/.pycharm_helpers/pydev'])
os.chdir('/app/src')
if 'setup' in dir(django): django.setup()
_original_argv = sys.argv[:]
try:
    sys.argv = [
        'manage.py',
        'shell_plus',
        '--command',
        'import builtins; builtins.__dict__["__pycharm_shell_plus_namespace__"] = dict(locals())',
    ]
    runpy.run_path('/app/src' + '/manage.py', run_name='__main__')
    globals().update(builtins.__dict__.pop('__pycharm_shell_plus_namespace__'))
finally:
    sys.argv = _original_argv
```

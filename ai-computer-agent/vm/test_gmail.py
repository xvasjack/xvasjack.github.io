import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from actions.gmail_api import _get_gmail_service
_get_gmail_service()
print("Gmail OAuth OK")

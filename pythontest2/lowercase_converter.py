import os 
def convert_to_lowercase(filepath):\n    try:\n        with open(filepath, 'r', encoding='utf-8') as file:\n            content = file.read()\n            lowercase_content = content.lower()\n            return lowercase_content\n    except FileNotFoundError:\n        return \"File not found.\"\n    except Exception as e:\n        return f\"An error occurred: {e}\" 
def convert_to_lowercase(filepath):\n    try:\n        with open(filepath, 'r', encoding='utf-8') as file:\n            content = file.read()\n            lowercase_content = content.lower()\n            return lowercase_content\n    except FileNotFoundError:\n        return \"File not found.\"\n    except Exception as e:\n        return f\"An error occurred: {e}\" 
import os 
lowercase_content = convert_to_lowercase(filepath)\nwrite_lowercase_content(filepath, lowercase_content) 
lowercase_content = convert_to_lowercase(filepath)\nwrite_lowercase_content(filepath, lowercase_content) 
def convert_to_lowercase(filepath):\n    try:\n        with open(filepath, 'r', encoding='utf-8') as file:\n            content = file.read()\n            lowercase_content = content.lower()\n            return lowercase_content\n    except FileNotFoundError:\n        return \"File not found.\"\n    except Exception as e:\n        return f\"An error occurred: {e}\" 
lowercase_content = convert_to_lowercase(filepath)\nwrite_lowercase_content(filepath, lowercase_content) 

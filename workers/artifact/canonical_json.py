import json,math

def normalized(value):
    if isinstance(value,float):
        if not math.isfinite(value):raise ValueError("Signed JSON cannot contain non-finite numbers")
        return int(value) if value.is_integer() else value
    if isinstance(value,list):return[normalized(item) for item in value]
    if isinstance(value,dict):return{key:normalized(item) for key,item in value.items()}
    return value

def canonical(value):return json.dumps(normalized(value),sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()

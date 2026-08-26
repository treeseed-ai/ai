import json,math

def normalized(value):
    if isinstance(value,float):
        if not math.isfinite(value):raise ValueError("Signed JSON cannot contain non-finite numbers")
        return int(value) if value.is_integer() else value
    if isinstance(value,list):return[normalized(item) for item in value]
    if isinstance(value,dict):return{key:normalized(item) for key,item in value.items()}
    return value

def json_bytes(value):return json.dumps(normalized(value),sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
def legacy_canonical(value):return json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
def number_token(value):
    if isinstance(value,int):return str(value)
    if not math.isfinite(value):raise ValueError("Signed JSON cannot contain non-finite numbers")
    if value==0:return"0"
    if value.is_integer():return str(int(value))
    token=format(value,".17g").lower()
    if "e" not in token:return token
    mantissa,exponent=token.split("e",1);return f"{mantissa}e{int(exponent)}"
def tagged(value):
    if value is None:return"n"
    if isinstance(value,bool):return"b1" if value else"b0"
    if isinstance(value,(int,float)):return"d"+number_token(value)
    if isinstance(value,str):return"s"+json.dumps(value,ensure_ascii=False,separators=(",",":"))
    if isinstance(value,list):return"a["+",".join(tagged(item) for item in value)+"]"
    if isinstance(value,dict):return"o{"+",".join(json.dumps(key,ensure_ascii=False)+":"+tagged(value[key]) for key in sorted(value))+"}"
    raise ValueError("Signed JSON contains an unsupported value")
def canonical(value):return("treeai-canonical-v2\n"+tagged(value)).encode()

function parts(value:string){return(value.match(/\d+(?:\.\d+){0,3}/u)?.[0]??'0').split('.').map(Number);}
export function compareVersions(left:string,right:string){const a=parts(left),b=parts(right);for(let index=0;index<Math.max(a.length,b.length);index++){const difference=(a[index]??0)-(b[index]??0);if(difference)return difference<0?-1:1;}return 0;}
export function withinRange(value:string,range:{minimum:string;maximumExclusive:string}){return compareVersions(value,range.minimum)>=0&&compareVersions(value,range.maximumExclusive)<0;}

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react'
import type { ChatSummary, CrmContactDetailsDto, CrmStageDto } from '../../../shared/contracts'
import { useUiStore } from '../store'

export function SalesLifecyclePath({ chat }: { chat: ChatSummary }): React.JSX.Element {
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const [optimisticStageId, setOptimisticStageId] = useState<string>()
  const stagesQuery = useQuery({
    queryKey: ['crm', 'pipeline'],
    queryFn: () => window.warish.crm.pipeline(),
    staleTime: 5 * 60_000
  })
  const stages = useMemo(() => [...(stagesQuery.data ?? [])].sort((left, right) => left.position - right.position), [stagesQuery.data])
  const activeStageId = optimisticStageId ?? chat.crm?.stageId
  const activeIndex = stages.findIndex((stage) => stage.id === activeStageId)

  useEffect(() => {
    if (optimisticStageId && chat.crm?.stageId === optimisticStageId) setOptimisticStageId(undefined)
  }, [chat.crm?.stageId, optimisticStageId])

  const stageMutation = useMutation({
    mutationFn: async (stage: CrmStageDto) => {
      if (chat.crm?.contactId) return window.warish.crm.contacts.setStage(chat.crm.contactId, stage.id)
      const contact: CrmContactDetailsDto = await window.warish.crm.contacts.ensure(chat.id)
      queryClient.setQueryData(['crm', 'contact', contact.id], contact)
      queryClient.setQueryData(['crm', 'contact', 'chat', chat.id], contact)
      return contact.stageId === stage.id ? contact : window.warish.crm.contacts.setStage(contact.id, stage.id)
    },
    onMutate: (stage) => setOptimisticStageId(stage.id),
    onSuccess: async (contact) => {
      queryClient.setQueryData(['crm', 'contact', contact.id], contact)
      queryClient.setQueryData(['crm', 'contact', 'chat', chat.id], contact)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['chat', chat.id] }),
        queryClient.invalidateQueries({ queryKey: ['chats'] }),
        queryClient.invalidateQueries({ queryKey: ['crm', 'contacts'] }),
        queryClient.invalidateQueries({ queryKey: ['crm', 'dashboard'] })
      ])
      setOptimisticStageId(undefined)
    },
    onError: (error) => {
      setOptimisticStageId(undefined)
      pushNotice(error instanceof Error ? error.message : 'Could not update the sales stage')
    }
  })

  return <section className="sales-lifecycle" aria-label="Sales lifecycle">
    <span className="sales-lifecycle-label"><strong>Sales lifecycle</strong><small>{chat.crm ? 'Pipeline' : 'Not tracked'}</small></span>
    <div className="sales-lifecycle-scroll">
      {stagesQuery.isLoading && <div className="sales-lifecycle-skeleton" aria-label="Loading sales lifecycle">
        {Array.from({ length: 5 }, (_, index) => <i key={index} />)}
      </div>}
      {stagesQuery.isError && <div className="sales-lifecycle-error"><CircleAlert /><span>Lifecycle unavailable</span>
        <button aria-label="Retry loading sales lifecycle" title="Retry" onClick={() => void stagesQuery.refetch()}><RefreshCw /></button></div>}
      {!stagesQuery.isLoading && !stagesQuery.isError && stages.length === 0 && <div className="sales-lifecycle-error"><CircleAlert /><span>No pipeline stages</span></div>}
      {stages.length > 0 && <div className="sales-lifecycle-path" role="group" aria-label="Pipeline stages">{stages.map((stage, index) => {
        const current = stage.id === activeStageId
        const completed = activeIndex >= 0 && index < activeIndex
        const pending = stageMutation.isPending && stageMutation.variables?.id === stage.id
        return <button key={stage.id} className={`${current ? 'current' : ''} ${completed ? 'completed' : ''} outcome-${stage.outcome}`}
          style={{ '--stage-color': stage.color } as CSSProperties} aria-current={current ? 'step' : undefined}
          aria-label={`Set sales stage to ${stage.name}`} title={stage.name} disabled={stageMutation.isPending}
          onClick={() => { if (!current || !chat.crm) stageMutation.mutate(stage) }}>
          <span className="sales-lifecycle-state">{pending ? <LoaderCircle className="spin" /> : completed ? <Check /> : null}</span>
          <span>{stage.name}</span>
        </button>
      })}</div>}
    </div>
  </section>
}
